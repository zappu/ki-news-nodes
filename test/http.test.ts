import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient, HttpError, isBlockedAddress, textOf } from "../src/core/http";

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1"])(
    "sperrt %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "172.32.0.1", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"])("erlaubt %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe("createHttpClient: Sperren vor dem Abruf", () => {
  const client = createHttpClient({ lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
  const get = (url: string) => client.request({ url, timeoutMs: 2000, maxBytes: 1000 });

  it.each(["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.1.1.1/"])("lehnt %s ab", async (url) => {
    await expect(get(url)).rejects.toMatchObject({ code: "blocked" });
  });
  it("lehnt Hostnamen ab, die auf interne Adressen zeigen", async () => {
    await expect(get("http://intern.example/")).rejects.toMatchObject({ code: "blocked" });
  });
  it("lehnt andere Protokolle, Ports und Zugangsdaten ab", async () => {
    await expect(get("file:///etc/passwd")).rejects.toBeInstanceOf(HttpError);
    await expect(get("http://example.com:22/")).rejects.toMatchObject({ code: "blocked" });
    await expect(get("http://user:pw@example.com/")).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("createHttpClient gegen einen lokalen Testserver", () => {
  let server: http.Server;
  let port = 0;
  // Der Testserver läuft auf 127.0.0.1; erlaubt wird nur er, 10.x bleibt gesperrt
  const client = () =>
    createHttpClient({
      lookup: async (host) => [{ address: host === "intern.test" ? "10.0.0.1" : "127.0.0.1", family: 4 }],
      isBlocked: (ip) => ip !== "127.0.0.1",
      extraPorts: [port],
    });
  const base = () => `http://public.test:${port}`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = req.url ?? "/";
      if (u === "/ok") {
        res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
        res.end(Buffer.from("<p>Größe</p>", "latin1"));
      } else if (u.startsWith("/redir/")) {
        const n = Number(u.split("/")[2]);
        res.writeHead(302, { location: n > 0 ? `/redir/${n - 1}` : "/ok" });
        res.end();
      } else if (u === "/to-intern") {
        res.writeHead(301, { location: "http://intern.test:8080/geheim" });
        res.end();
      } else if (u === "/big") {
        res.writeHead(200);
        res.end("x".repeat(5000));
      } else if (u === "/slow") {
        setTimeout(() => res.end("spät"), 1500);
      } else if (u === "/echo" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ got: JSON.parse(body), ct: req.headers["content-type"] }));
        });
      } else {
        res.writeHead(404);
        res.end("nicht da");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("liest eine Seite und dekodiert den Zeichensatz", async () => {
    const res = await client().request({ url: `${base()}/ok`, timeoutMs: 2000, maxBytes: 10_000 });
    expect(res.status).toBe(200);
    expect(textOf(res)).toBe("<p>Größe</p>");
  });
  it("folgt höchstens 3 Weiterleitungen", async () => {
    const ok = await client().request({ url: `${base()}/redir/2`, timeoutMs: 2000, maxBytes: 10_000 });
    expect(ok.url).toBe(`${base()}/ok`);
    await expect(client().request({ url: `${base()}/redir/3`, timeoutMs: 2000, maxBytes: 10_000 })).rejects.toMatchObject({ code: "redirects" });
  });
  it("lehnt Weiterleitungen ins interne Netz ab", async () => {
    await expect(client().request({ url: `${base()}/to-intern`, timeoutMs: 2000, maxBytes: 10_000 })).rejects.toMatchObject({ code: "blocked" });
  });
  it("bricht bei zu großer Antwort ab", async () => {
    await expect(client().request({ url: `${base()}/big`, timeoutMs: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });
  it("bricht nach dem Zeitlimit ab", async () => {
    await expect(client().request({ url: `${base()}/slow`, timeoutMs: 300, maxBytes: 1000 })).rejects.toMatchObject({ code: "timeout" });
  });
  it("sendet JSON per POST", async () => {
    const res = await client().request({ method: "POST", url: `${base()}/echo`, json: { a: 1 }, timeoutMs: 2000, maxBytes: 10_000 });
    expect(JSON.parse(textOf(res))).toEqual({ got: { a: 1 }, ct: "application/json" });
  });

});
