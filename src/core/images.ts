/**
 * Teaserbilder erzeugen und prüfen (KNP 1.4.0 bis 1.7.0):
 * - fal.ai (synchroner Aufruf, `landscape_16_9`) oder OpenRouter (Bildmodelle wie Gemini, `modalities`),
 * - Bilddaten sind fremde Eingaben: Data-URLs streng dekodieren, Bild-URLs nur über den geschützten
 *   HTTP-Client, höchstens 8 MiB, Typ aus den Bytes (nur JPEG, PNG, WebP),
 * - PNG wird in JPEG mit Qualität 80 umgewandelt (Gemini liefert PNGs um 2 MB).
 */
import sharp, { type Metadata } from "sharp";
import { textOf, type HttpClient } from "./http";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 120_000;
export const FAL_ENDPOINT = "https://fal.run/";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_FAL_MODEL = "fal-ai/flux/schnell";
export const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";

export type ImageProvider = "fal" | "openrouter";

export interface ImageKeys {
  fal?: string | null;
  openrouter?: string | null;
  /** Adresse der Seite für den `HTTP-Referer` bei OpenRouter */
  siteUrl?: string | null;
}

export interface FinalImage {
  buffer: Buffer;
  mime: "image/jpeg" | "image/webp";
  ext: "jpg" | "webp";
  width: number;
  height: number;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

/** Modell für den Anbieter; der fal-Standard passt nicht zu OpenRouter und umgekehrt */
export function imageModelFor(provider: ImageProvider, configured: string): string {
  const m = configured.trim();
  if (provider === "openrouter") return m && m !== DEFAULT_FAL_MODEL && !m.startsWith("fal-ai/") ? m : DEFAULT_OPENROUTER_IMAGE_MODEL;
  return m && m.startsWith("fal-ai/") ? m : DEFAULT_FAL_MODEL;
}

/** Data-URL nur als `data:image/(jpeg|png|webp);base64,…`, Größe vor und nach dem Dekodieren geprüft */
export function decodeImageDataUrl(url: string): Buffer {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url.trim());
  if (!m) throw new Error("Bild: ungültige Data-URL");
  const b64 = m[2]!;
  if (b64.length % 4 !== 0) throw new Error("Bild: Base64 hat eine ungültige Länge");
  if ((b64.length / 4) * 3 > IMAGE_MAX_BYTES + 3) throw new Error("Bild: größer als 8 MiB");
  const buf = Buffer.from(b64, "base64");
  if (buf.length > IMAGE_MAX_BYTES) throw new Error("Bild: größer als 8 MiB");
  if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) throw new Error("Bild: Base64 ist nicht sauber kodiert");
  return buf;
}

/** Bilddaten von einer Data-URL oder einer normalen URL holen (URL über den geschützten Client) */
export async function loadImageSource(http: HttpClient, url: string): Promise<Buffer> {
  if (url.startsWith("data:")) return decodeImageDataUrl(url);
  const res = await http.request({ url, timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES, maxRedirects: 3, headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5" } });
  if (res.status < 200 || res.status > 299) throw new Error(`Bild: Download HTTP ${res.status}`);
  return res.body;
}

/**
 * Typ aus den Bytes bestimmen, nur JPEG, PNG, WebP. PNG wird zu JPEG mit Qualität 80,
 * JPEG und WebP bleiben unverändert.
 */
export async function finalizeImage(buf: Buffer): Promise<FinalImage> {
  if (!buf.length) throw new Error("Bild: leere Datei");
  if (buf.length > IMAGE_MAX_BYTES) throw new Error("Bild: größer als 8 MiB");
  let meta: Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new Error("Bild: Datei ist kein lesbares Bild");
  }
  const size = { width: meta.width ?? 0, height: meta.height ?? 0 };
  if (meta.format === "jpeg") return { buffer: buf, mime: "image/jpeg", ext: "jpg", ...size };
  if (meta.format === "webp") return { buffer: buf, mime: "image/webp", ext: "webp", ...size };
  if (meta.format === "png") {
    const jpeg = await sharp(buf).flatten({ background: "#ffffff" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    return { buffer: jpeg, mime: "image/jpeg", ext: "jpg", ...size };
  }
  throw new Error(`Bild: Format ${meta.format ?? "unbekannt"} nicht erlaubt (nur JPEG, PNG, WebP)`);
}

async function falImage(http: HttpClient, key: string, model: string, prompt: string): Promise<string> {
  if (!MODEL_RE.test(model)) throw new Error(`Bild: ungültiger Modellname ${model}`);
  const res = await http.request({
    method: "POST",
    url: FAL_ENDPOINT + model,
    headers: { Authorization: `Key ${key}`, Accept: "application/json" },
    json: { prompt, image_size: "landscape_16_9", num_images: 1 },
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
  });
  const text = textOf(res);
  if (res.status < 200 || res.status > 299) throw new Error(`fal.ai HTTP ${res.status}: ${errorDetail(text)}`);
  let data: { images?: { url?: unknown }[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("fal.ai: Antwort ist kein JSON");
  }
  const url = data.images?.[0]?.url;
  if (typeof url !== "string" || !url) throw new Error("fal.ai: Antwort ohne Bild-URL");
  return url;
}

async function openRouterImage(http: HttpClient, key: string, model: string, prompt: string, siteUrl: string | null | undefined): Promise<string> {
  if (!MODEL_RE.test(model)) throw new Error(`Bild: ungültiger Modellname ${model}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "X-Title": "KI News Nodes" };
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  const res = await http.request({
    method: "POST",
    url: OPENROUTER_ENDPOINT,
    headers,
    json: { model, modalities: ["image", "text"], messages: [{ role: "user", content: prompt }] },
    timeoutMs: IMAGE_TIMEOUT_MS,
    // Antwort enthält das Bild meist als Base64
    maxBytes: Math.ceil(IMAGE_MAX_BYTES * 1.4) + 64 * 1024,
  });
  const text = textOf(res);
  if (res.status !== 200) throw new Error(`OpenRouter HTTP ${res.status}: ${errorDetail(text)}`);
  let data: { choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("OpenRouter: Antwort ist kein JSON");
  }
  const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (typeof url !== "string" || !url) throw new Error("OpenRouter: Antwort ohne Bild");
  return url;
}

function errorDetail(text: string): string {
  try {
    const v = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown; message?: string };
    if (typeof v.error === "string") return v.error;
    if (v.error?.message) return v.error.message;
    if (typeof v.detail === "string") return v.detail;
    if (v.message) return v.message;
  } catch {
    /* kein JSON */
  }
  return text.slice(0, 200);
}

/** Bild zum Briefing erzeugen, laden, prüfen und umwandeln */
export async function generateTeaserImage(http: HttpClient, provider: ImageProvider, model: string, keys: ImageKeys, briefing: string): Promise<FinalImage> {
  const key = provider === "fal" ? keys.fal?.trim() : keys.openrouter?.trim();
  if (!key) throw new Error(provider === "fal" ? "kein fal.ai-Schlüssel hinterlegt (FAL_KEY)" : "kein OpenRouter-Schlüssel hinterlegt (OPENROUTER_API_KEY)");
  const m = imageModelFor(provider, model);
  const url = provider === "fal" ? await falImage(http, key, m, briefing) : await openRouterImage(http, key, m, briefing, keys.siteUrl);
  return finalizeImage(await loadImageSource(http, url));
}
