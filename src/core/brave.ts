/**
 * Brave News Search und die Bausteine der Themensuche (KNP 1.10.0 bis 1.12.1): Suchanfragen,
 * Zeitplan-Slots über den Tag, Bereinigung und Wortvergleich von Überschriften.
 */
import { BROWSER_HEADERS, textOf, type HttpClient } from "./http";
import { stripHtml } from "./text";
import { localDayKey, localTimeOnDay } from "./time";
import { urlHash } from "./urls";

export const BRAVE_NEWS_ENDPOINT = "https://api.search.brave.com/res/v1/news/search";
export const BRAVE_MAX_RESULTS = 90;
export const BRAVE_DESC_MAX = 300;

const COUNTRY_FOR_LANG: Record<string, string> = { de: "DE", fr: "FR", es: "ES", it: "IT", pt: "PT", nl: "NL" };

export interface BraveResult {
  title: string;
  url: string;
  desc: string;
  age?: string;
}

export class BraveRateLimitError extends Error {
  constructor() {
    super("Anfragelimit erreicht");
  }
}

/** Suchzeile `de|Suchbegriff`: Präfix setzt die Suchsprache, ohne Präfix englisch */
export function parseQueryLine(line: string): { query: string; lang: string } {
  const m = /^([a-z]{2})\|(.+)$/i.exec(line.trim());
  if (m) return { lang: m[1]!.toLowerCase(), query: m[2]!.trim() };
  return { lang: "en", query: line.trim() };
}

/** Suchsprache aus der Ausgabesprache (für die Nachsuche) */
export function langFromLanguage(language: string): string {
  const l = language.trim().toLowerCase();
  const map: [RegExp, string][] = [
    [/^(de|deutsch|german)/, "de"],
    [/^(en|englisch|english)/, "en"],
    [/^(fr|französisch|franzoesisch|french)/, "fr"],
    [/^(es|spanisch|spanish)/, "es"],
    [/^(it|italienisch|italian)/, "it"],
    [/^(pt|portugiesisch|portuguese)/, "pt"],
    [/^(nl|niederländisch|niederlaendisch|dutch)/, "nl"],
  ];
  return map.find(([re]) => re.test(l))?.[1] ?? "en";
}

/** Zeitraum `JJJJ-MM-TTtoJJJJ-MM-TT` von heute minus `days` bis heute */
export function freshness(now: Date, days: number, tz: string): string {
  const from = new Date(now.getTime() - days * 86_400_000);
  return `${localDayKey(from, tz)}to${localDayKey(now, tz)}`;
}

export interface BraveSearchOptions {
  apiKey: string;
  query: string;
  lang: string;
  count: number;
  days: number;
  now: Date;
  tz: string;
}

export function braveSearchUrl(o: Omit<BraveSearchOptions, "apiKey">): string {
  const params = new URLSearchParams({ q: o.query, count: String(o.count), freshness: freshness(o.now, o.days, o.tz), search_lang: o.lang, spellcheck: "0" });
  const country = COUNTRY_FOR_LANG[o.lang];
  if (country) params.set("country", country);
  // RFC 3986: Leerzeichen als %20 statt +
  return `${BRAVE_NEWS_ENDPOINT}?${params.toString().replace(/\+/g, "%20")}`;
}

/** Eine Anfrage an Brave News Search; 429 wirft `BraveRateLimitError` */
export async function braveSearch(http: HttpClient, o: BraveSearchOptions): Promise<BraveResult[]> {
  const res = await http.request({
    url: braveSearchUrl(o),
    headers: { Accept: "application/json", "X-Subscription-Token": o.apiKey, "User-Agent": BROWSER_HEADERS["User-Agent"]! },
    timeoutMs: 30_000,
    maxBytes: 2 * 1024 * 1024,
  });
  if (res.status === 429) throw new BraveRateLimitError();
  if (res.status !== 200) throw new Error(`Brave HTTP ${res.status}: ${textOf(res).slice(0, 200)}`);
  let data: { results?: unknown };
  try {
    data = JSON.parse(textOf(res)) as { results?: unknown };
  } catch {
    throw new Error("Brave: Antwort ist kein JSON");
  }
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  return results
    .map((r) => ({
      title: stripHtml(typeof r.title === "string" ? r.title : ""),
      url: typeof r.url === "string" ? r.url.trim() : "",
      desc: stripHtml(typeof r.description === "string" ? r.description : "").slice(0, BRAVE_DESC_MAX),
      ...(typeof r.age === "string" && r.age ? { age: r.age } : {}),
    }))
    .filter((r) => r.url);
}

/** Treffer über die URL entdoppeln, höchstens `max` */
export function dedupeResults(results: BraveResult[], max = BRAVE_MAX_RESULTS): BraveResult[] {
  const seen = new Set<string>();
  const out: BraveResult[] = [];
  for (const r of results) {
    const h = urlHash(r.url);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

// ─── Zeitplan-Slots ─────────────────────────────────────────────────────────────────────────────

/**
 * Slot k (0-basiert) ist fällig ab Mitternacht + (start + k * (ende - start) / n) Stunden, Ortszeit.
 * Liefert die Zahl der heute schon fälligen Slots und den Zeitpunkt des nächsten.
 */
export function braveSlots(now: Date, tz: string, perDay: number, startHour: number, endHour: number): { due: number; next: Date | null } {
  const n = Math.max(1, perDay);
  const span = Math.max(1, endHour - startHour);
  let due = 0;
  let next: Date | null = null;
  for (let k = 0; k < n; k++) {
    const minutes = Math.round((startHour + (k * span) / n) * 60);
    const at = localTimeOnDay(now, tz, Math.floor(minutes / 60), minutes % 60);
    if (at.getTime() <= now.getTime()) due++;
    else if (!next) next = at;
  }
  return { due, next };
}

export function formatLocalTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(date);
}

// ─── Überschriften ──────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  "the and for with new how you your now can that this from der die das und mit für von ein eine ist neue neu wie zum zur den dem des jetzt auf bei sie ihr was".split(" "),
);

/** Bedeutungstragende Wörter: klein, ohne Satzzeichen, ab 3 Zeichen, ohne Stoppwörter */
export function significantWords(headline: string): Set<string> {
  const words = headline
    .toLocaleLowerCase("de")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Wortvergleich (Sicherheitsnetz hinter der KI): beide mindestens 3 Wörter und Jaccard >= 0,5 */
export function isSimilarHeadline(a: string, b: string): boolean {
  const wa = significantWords(a);
  const wb = significantWords(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return inter / union >= 0.5;
}

/** Überschrift aus der KI bereinigen: Nummern, Spiegelstriche, Anführungszeichen, Sternchen am Rand weg */
export function cleanHeadline(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/^(\d+[.)]\s*|[-–—•*]+\s*)/, "")
      .replace(/^["'„“”‚‘’»«]+|["'„“”‚‘’»«]+$/g, "")
      .replace(/^\*+|\*+$/g, "")
      .trim();
  }
  return s;
}

/** Bekannte Überschriften bereinigen: 12 bis 220 Zeichen, entdoppelt ohne Groß-/Kleinschreibung */
export function normalizeKnownHeadlines(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const h = stripHtml(raw).replace(/\s+/g, " ").trim();
    if (h.length < 12 || h.length > 220) continue;
    const key = h.toLocaleLowerCase("de");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
