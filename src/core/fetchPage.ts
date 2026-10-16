/**
 * Quellseiten abrufen (Crawl, Recherche, Vergleichsseiten) mit Browser-Kopfzeilen und den Grenzen aus KNP:
 * höchstens 3 Weiterleitungen, 2 MiB, Zeitlimit 30 s (Vergleichsseiten 20 s).
 */
import { extractArticleText, CRAWL_MIN_CHARS } from "./html";
import { BROWSER_HEADERS, textOf, type HttpClient } from "./http";

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;

export async function fetchPageHtml(http: HttpClient, url: string, timeoutMs = 30_000): Promise<string> {
  const res = await http.request({ url, headers: BROWSER_HEADERS, timeoutMs, maxBytes: PAGE_MAX_BYTES, maxRedirects: 3 });
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
  return textOf(res);
}

export class CrawlTooShortError extends Error {}

/** Artikeltext einer Seite; wirft, wenn weniger als 300 Zeichen übrig bleiben */
export async function crawlArticle(http: HttpClient, url: string, maxChars?: number): Promise<string> {
  const html = await fetchPageHtml(http, url);
  const text = extractArticleText(html, maxChars);
  if (text.length < CRAWL_MIN_CHARS) throw new CrawlTooShortError(`extrahierter Text zu kurz (${text.length} Zeichen)`);
  return text;
}
