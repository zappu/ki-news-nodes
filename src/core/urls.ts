import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref"]);

export function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/**
 * Normalisiert eine URL für den Duplikatabgleich (Regeln aus KNP 1.4.0):
 * Schema weg, Host klein, Fragment weg, Tracking-Parameter weg, übrige Parameter sortiert,
 * Schrägstrich am Pfadende weg. Ergebnis `host + pfad + ?query`. Ungültige URLs: getrimmt zurück.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  let path = u.pathname.replace(/\/+$/, "");
  const port = u.port ? ":" + u.port : "";
  return u.hostname.toLowerCase() + port + path + query;
}

export function urlHash(raw: string): string {
  return md5(normalizeUrl(raw));
}

/** GUID eines RSS-Items: md5(Item-GUID oder Link) */
export function rssGuid(itemGuid: string | null | undefined, link: string): string {
  return md5((itemGuid && itemGuid.trim()) || link);
}

/** GUID eines Brave-Themas: md5('brave|' + Überschrift in Kleinbuchstaben) */
export function braveGuid(headline: string): string {
  return md5("brave|" + headline.toLowerCase());
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
