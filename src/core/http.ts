/**
 * Zentraler HTTP-Client für alle Abrufe nach außen (Feeds, Quellseiten, Vergleichsseiten, APIs, Bilder).
 *
 * Schutz gegen Abrufe ins interne Netz (SSRF):
 * - nur http und https, nur die Ports 80, 443 und 8080 (wie `wp_safe_remote_get`),
 * - IP-Literale werden direkt geprüft, Hostnamen beim Verbindungsaufbau über eine eigene DNS-Auflösung
 *   (damit greift die Prüfung auch bei DNS-Rebinding),
 * - Weiterleitungen folgt der Client selbst und prüft jedes Ziel neu.
 * Dazu Zeitlimit für den ganzen Abruf und ein Größenlimit beim Lesen der Antwort.
 *
 * In Tests wird der Client durch eine Attrappe ersetzt (`createFakeHttp` in `test/helpers`).
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, request } from "undici";

export interface HttpRequest {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  /** Wird als JSON gesendet */
  json?: unknown;
  timeoutMs: number;
  maxBytes: number;
  /** Höchstzahl der Weiterleitungen (Standard 3) */
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  /** Endgültige URL nach Weiterleitungen */
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: "blocked" | "timeout" | "too_large" | "redirects" | "network",
  ) {
    super(message);
  }
}

/** Kopfzeilen wie ein Browser (KNP 1.12.1); die Chrome-Version gelegentlich anheben */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

const ALLOWED_PORTS = new Set(["", "80", "443", "8080"]);

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** true, wenn die Adresse privat, lokal oder sonst nicht öffentlich ist */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 in IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) nach der IPv4-Regel prüfen
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return BLOCKED.check(mapped[1]!, "ipv4");
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return BLOCKED.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return BLOCKED.check(lower, "ipv6");
  }
  return true;
}

type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface HttpClientOptions {
  /** Eigene DNS-Auflösung (Tests) */
  lookup?: LookupFn;
  /** Eigene Sperrprüfung (Tests, um einen lokalen Testserver zu erlauben) */
  isBlocked?: (ip: string) => boolean;
  /** Zusätzlich erlaubte Ports (Tests mit zufälligem Port) */
  extraPorts?: number[];
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const lookup = opts.lookup ?? defaultLookup;
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const ports = new Set([...ALLOWED_PORTS, ...(opts.extraPorts ?? []).map(String)]);

  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname)
          .then((addrs) => {
            const allowed = addrs.filter((a) => !isBlocked(a.address));
            if (!addrs.length || allowed.length !== addrs.length) {
              callback(new HttpError(`Abruf gesperrt: ${hostname} zeigt auf eine interne Adresse`, "blocked"), "", 4);
              return;
            }
            const all = (options as { all?: boolean }).all;
            if (all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, allowed);
            else callback(null, allowed[0]!.address, allowed[0]!.family);
          })
          .catch((e: Error) => callback(e, "", 4));
      },
    },
  });

  function checkUrl(raw: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new HttpError(`Ungültige URL: ${raw.slice(0, 200)}`, "blocked");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(`Protokoll nicht erlaubt: ${u.protocol}`, "blocked");
    if (u.username || u.password) throw new HttpError("URLs mit Zugangsdaten sind nicht erlaubt", "blocked");
    if (!ports.has(u.port)) throw new HttpError(`Port nicht erlaubt: ${u.port}`, "blocked");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlocked(host)) throw new HttpError(`Abruf gesperrt: ${host} ist eine interne Adresse`, "blocked");
    if (host === "localhost" || host.endsWith(".localhost")) throw new HttpError("Abruf gesperrt: localhost", "blocked");
    return u;
  }

  return {
    async request(req) {
      const maxRedirects = req.maxRedirects ?? 3;
      const signal = AbortSignal.timeout(req.timeoutMs);
      let url = checkUrl(req.url);
      let method = req.method ?? "GET";
      let body: string | undefined = req.json === undefined ? undefined : JSON.stringify(req.json);
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (body !== undefined) headers["Content-Type"] ??= "application/json";

      for (let hop = 0; ; hop++) {
        let res;
        try {
          res = await request(url, { method, headers, body, dispatcher: agent, signal });
        } catch (e) {
          throw wrapError(e, req.timeoutMs);
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          await res.body.dump().catch(() => undefined);
          if (hop >= maxRedirects) throw new HttpError(`Zu viele Weiterleitungen (mehr als ${maxRedirects})`, "redirects");
          const loc = Array.isArray(res.headers.location) ? res.headers.location[0]! : res.headers.location;
          url = checkUrl(new URL(loc, url).toString());
          if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
            delete headers["Content-Type"];
          }
          continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of res.body) {
            size += (chunk as Buffer).length;
            if (size > req.maxBytes) {
              res.body.destroy();
              throw new HttpError(`Antwort größer als ${Math.round(req.maxBytes / 1024)} KiB`, "too_large");
            }
            chunks.push(chunk as Buffer);
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw wrapError(e, req.timeoutMs);
        }
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        return { status: res.statusCode, url: url.toString(), headers: outHeaders, body: Buffer.concat(chunks) };
      }
    },
  };
}

function wrapError(e: unknown, timeoutMs: number): HttpError {
  if (e instanceof HttpError) return e;
  const err = e as { name?: string; message?: string; cause?: unknown };
  if (err.cause instanceof HttpError) return err.cause;
  if (err.name === "TimeoutError" || err.name === "AbortError") return new HttpError(`Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s`, "timeout");
  return new HttpError(`Netzwerkfehler: ${err.message ?? String(e)}`, "network");
}

/**
 * Antworttext dekodieren: Zeichensatz aus dem Content-Type, sonst aus einer Meta-Angabe bzw. der
 * XML-Deklaration am Anfang, sonst UTF-8 (manche Seiten liefern noch ISO-8859-1).
 */
export function textOf(res: HttpResponse): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(res.headers["content-type"] ?? "")?.[1];
  const head = res.body.subarray(0, 2048).toString("latin1");
  const fromDoc = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  const label = (fromHeader ?? fromDoc ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(res.body);
  } catch {
    return res.body.toString("utf8");
  }
}
