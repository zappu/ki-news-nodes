/**
 * Gemeinsame Typen des Pipeline-Kerns. Der Kern kennt keine Blog-Tabelle und kein Admin-Backend;
 * alles Seitenspezifische kommt über die Ports unten (KI-Funktion, HTTP-Client, Ziel-Adapter).
 */

export const QUEUE_STATUSES = ["new", "crawled", "classified", "approved", "published", "rejected", "failed"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type SourceKind = "rss" | "brave";

/** Markierung für Brave-Themen in `feedUrl` (wie in KNP) */
export const BRAVE_FEED_MARK = "brave:search";

export interface SourceRef {
  title: string;
  url: string;
  desc?: string;
  age?: string;
}

/** Ein Queue-Eintrag (Zeile in `news_queue`) */
export interface QueueEntry {
  id: number;
  siteId: string;
  profileId: number;
  guid: string;
  urlHash: string | null;
  feedUrl: string;
  sourceUrl: string;
  sourceName: string;
  sourceList: SourceRef[] | null;
  titleOriginal: string;
  publishedAt: Date | null;
  fullContent: string | null;
  status: QueueStatus;
  relevance: boolean | null;
  rewrittenTitle: string | null;
  rewrittenContent: string | null;
  teaserText: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  categoryKey: string | null;
  tags: string[];
  imageBriefing: string | null;
  imageRef: string | null;
  postRef: string | null;
  error: string | null;
  attempts: number;
  retryStatus: QueueStatus | null;
  /** Zeitpunkt des KI-Rewrites (für das Artikelziel pro Tag) */
  classifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function sourceKindOf(entry: Pick<QueueEntry, "feedUrl">): SourceKind {
  return entry.feedUrl === BRAVE_FEED_MARK ? "brave" : "rss";
}

// ─── KI ─────────────────────────────────────────────────────────────────────────────────────────

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Zeitlimit für den Aufruf; KNP gibt 180 s */
  timeoutMs: number;
  /** Wofür der Aufruf ist (Protokoll, Kostenzähler) */
  purpose: "classify" | "brave-select" | "style-derive" | "style-sample";
}

/** KI-Aufruf der Zielseite (bei den SSR-Seiten die KI-Kette aus `server/_core/llm.ts`). Liefert den Antworttext. */
export type LlmFn = (req: LlmRequest) => Promise<string>;

// ─── Kategorien und Ziel-Adapter ────────────────────────────────────────────────────────────────

export interface Category {
  /** Schlüssel, den die KI zurückgibt */
  key: string;
  /** Anzeigename, so wie die Zielseite ihn speichert */
  name: string;
}

export interface PostPayload {
  title: string;
  /** Grundlage für den Slug; die Zielseite macht ihn eindeutig */
  slugBase: string;
  /** KI-Text als HTML, bereits über die Positivliste gefiltert, ohne Quellen und KI-Hinweis */
  html: string;
  excerpt: string;
  status: "draft" | "published";
  author: string | null;
  /** Kategoriename laut Zielseite, null = keine */
  category: string | null;
  tags: string[];
  imageRef: string | null;
  imageAlt: string | null;
  seoTitle: string;
  seoDescription: string;
  /** Quellen für die Quellenangabe; leer, wenn die Quellenangabe aus ist */
  sources: { title: string; url: string }[];
  sourceKind: SourceKind;
  /** KI-Hinweis; leer = keiner */
  aiDisclosure: string;
  origin: { queueId: number; sourceUrl: string };
}

/**
 * Ziel-Adapter: alles, was der Kern über die Zielseite wissen oder dort tun muss.
 * Die Umwandlung in das Speicherformat der Seite (bei den SSR-Seiten Markdown) ist Sache des Adapters.
 */
export interface PublishTarget {
  /** Kategorien, aus denen die KI wählt */
  categories(): Promise<Category[]>;
  /** Titel der letzten Beiträge für den Brave-Abgleich */
  recentTitles(limit: number): Promise<string[]>;
  /** Schon angelegten Beitrag zu diesem Queue-Eintrag finden (Idempotenz) */
  findExisting(q: { queueId: number; title: string; fingerprint: string }): Promise<string | null>;
  createPost(post: PostPayload): Promise<{ ref: string; url?: string }>;
  /** Vorhandenen Beitrag vervollständigen (nach abgebrochenem Lauf) */
  completePost(ref: string, post: PostPayload): Promise<void>;
}

// ─── Protokoll ──────────────────────────────────────────────────────────────────────────────────

export interface RunLogger {
  log(line: string): void;
}
