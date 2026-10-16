/**
 * RSS 2.0, Atom und RDF lesen und auf eine einheitliche Form bringen (Datum, Link, GUID, Titel, Feed-Titel).
 */
import { parseFeed } from "feedsmith";
import { BROWSER_HEADERS, textOf, type HttpClient } from "./http";
import { stripHtml } from "./text";

export interface FeedItem {
  guid: string | null;
  link: string;
  title: string;
  date: Date | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

export async function fetchFeed(http: HttpClient, url: string): Promise<ParsedFeed> {
  const res = await http.request({ url, headers: { ...BROWSER_HEADERS, Accept: FEED_ACCEPT }, timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 });
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
  return parseFeedXml(textOf(res));
}

type Loose = Record<string, unknown>;

const asText = (v: unknown): string => {
  if (typeof v === "string") return stripHtml(v);
  if (v && typeof v === "object" && typeof (v as Loose).value === "string") return stripHtml((v as Loose).value as string);
  return "";
};

const asDate = (...vals: unknown[]): Date | null => {
  for (const v of vals) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s !== "string" || !s.trim()) continue;
    const d = new Date(s.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

export function parseFeedXml(xml: string): ParsedFeed {
  let parsed: { format: string; feed: unknown };
  try {
    parsed = parseFeed(xml) as { format: string; feed: unknown };
  } catch (e) {
    throw new Error(`kein gültiger Feed (${(e as Error).message.slice(0, 120)})`);
  }
  const feed = (parsed.feed ?? {}) as Loose;
  const title = asText(feed.title);

  if (parsed.format === "atom") {
    const entries = (Array.isArray(feed.entries) ? feed.entries : []) as Loose[];
    return {
      title,
      items: entries.map((e) => {
        const links = (Array.isArray(e.links) ? e.links : []) as Loose[];
        const alt = links.find((l) => !l.rel || l.rel === "alternate") ?? links[0];
        return {
          guid: typeof e.id === "string" ? e.id : null,
          link: typeof alt?.href === "string" ? alt.href.trim() : "",
          title: asText(e.title),
          date: asDate(e.published, e.updated),
        };
      }),
    };
  }

  if (parsed.format === "rss" || parsed.format === "rdf") {
    const items = (Array.isArray(feed.items) ? feed.items : []) as Loose[];
    return {
      title,
      items: items.map((i) => {
        const guidRaw = i.guid;
        const guid = typeof guidRaw === "string" ? guidRaw : guidRaw && typeof (guidRaw as Loose).value === "string" ? ((guidRaw as Loose).value as string) : null;
        const dc = (i.dc ?? {}) as Loose;
        return {
          guid,
          link: typeof i.link === "string" ? i.link.trim() : "",
          title: asText(i.title),
          date: asDate(i.pubDate, dc.dates, dc.date),
        };
      }),
    };
  }

  if (parsed.format === "json") {
    const items = (Array.isArray(feed.items) ? feed.items : []) as Loose[];
    return {
      title,
      items: items.map((i) => ({
        guid: typeof i.id === "string" ? i.id : null,
        link: typeof i.url === "string" ? i.url.trim() : "",
        title: asText(i.title),
        date: asDate(i.date_published, i.date_modified),
      })),
    };
  }

  throw new Error(`unbekanntes Feed-Format ${parsed.format}`);
}
