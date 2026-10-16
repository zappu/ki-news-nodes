/**
 * Datenzugriff des Pakets auf MySQL/MariaDB (Tabellen `news_*`).
 * Die Verbindung muss in UTC arbeiten; `createNewsStore({ url })` richtet das selbst ein.
 */
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { parseProfileConfig, parseSiteSettings, type Profile, type ProfileConfig, type SiteSettings } from "../core/settings";
import { clipError } from "../core/text";
import { BRAVE_FEED_MARK, QUEUE_STATUSES, type QueueEntry, type QueueStatus, type SourceKind, type SourceRef } from "../core/types";
import { migrate } from "./migrations";

export const MAX_ATTEMPTS = 3;

/** Felder, die beim Anlegen eines Queue-Eintrags gesetzt werden */
export interface NewEntry {
  siteId: string;
  profileId: number;
  guid: string;
  urlHash: string | null;
  feedUrl: string;
  sourceUrl: string;
  sourceName: string;
  sourceList?: SourceRef[] | null;
  titleOriginal: string;
  publishedAt: Date | null;
}

export type EntryPatch = Partial<
  Pick<
    QueueEntry,
    | "urlHash"
    | "sourceUrl"
    | "sourceList"
    | "fullContent"
    | "status"
    | "relevance"
    | "rewrittenTitle"
    | "rewrittenContent"
    | "teaserText"
    | "seoTitle"
    | "seoDescription"
    | "categoryKey"
    | "tags"
    | "imageBriefing"
    | "imageRef"
    | "postRef"
    | "error"
    | "attempts"
    | "retryStatus"
  >
>;

const COLUMN: Record<keyof EntryPatch, string> = {
  urlHash: "url_hash",
  sourceUrl: "source_url",
  sourceList: "source_list",
  fullContent: "full_content",
  status: "status",
  relevance: "relevance",
  rewrittenTitle: "rewritten_title",
  rewrittenContent: "rewritten_content",
  teaserText: "teaser_text",
  seoTitle: "seo_title",
  seoDescription: "seo_description",
  categoryKey: "category_key",
  tags: "tags",
  imageBriefing: "image_briefing",
  imageRef: "image_ref",
  postRef: "post_ref",
  error: "error",
  attempts: "attempts",
  retryStatus: "retry_status",
};

function toDb(key: keyof EntryPatch, value: unknown): unknown {
  if (key === "sourceList") return value == null ? null : JSON.stringify(value);
  if (key === "tags") return JSON.stringify(Array.isArray(value) ? value : []);
  if (key === "relevance") return value == null ? null : value ? 1 : 0;
  if (key === "error" && typeof value === "string") return clipError(value);
  return value ?? null;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function rowToEntry(r: RowDataPacket): QueueEntry {
  const status = (QUEUE_STATUSES as readonly string[]).includes(r.status) ? (r.status as QueueStatus) : "failed";
  const retry = (QUEUE_STATUSES as readonly string[]).includes(r.retry_status) ? (r.retry_status as QueueStatus) : null;
  return {
    id: r.id,
    siteId: r.site_id,
    profileId: r.profile_id,
    guid: r.guid,
    urlHash: r.url_hash,
    feedUrl: r.feed_url,
    sourceUrl: r.source_url,
    sourceName: r.source_name,
    sourceList: parseJson<SourceRef[] | null>(r.source_list, null),
    titleOriginal: r.title_original,
    publishedAt: r.published_at,
    fullContent: r.full_content,
    status,
    relevance: r.relevance == null ? null : r.relevance === 1,
    rewrittenTitle: r.rewritten_title,
    rewrittenContent: r.rewritten_content,
    teaserText: r.teaser_text,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    categoryKey: r.category_key,
    tags: parseJson<string[]>(r.tags, []),
    imageBriefing: r.image_briefing,
    imageRef: r.image_ref,
    postRef: r.post_ref,
    error: r.error,
    attempts: r.attempts,
    retryStatus: retry,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class NewsStore {
  constructor(
    readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  migrate(): Promise<number[]> {
    return migrate(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─── Einstellungen ───────────────────────────────────────────────────────────────────────────

  async getSettings(siteId: string): Promise<SiteSettings> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT config FROM news_settings WHERE site_id = ?", [siteId]);
    return parseSiteSettings(parseJson(rows[0]?.config, {}));
  }

  async saveSettings(siteId: string, input: unknown): Promise<SiteSettings> {
    const clean = parseSiteSettings(input);
    await this.pool.query(
      "INSERT INTO news_settings (site_id, config, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config = VALUES(config), updated_at = VALUES(updated_at)",
      [siteId, JSON.stringify(clean), this.now()],
    );
    return clean;
  }

  // ─── Profile ─────────────────────────────────────────────────────────────────────────────────

  async listProfiles(siteId: string, opts: { activeOnly?: boolean } = {}): Promise<Profile[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, site_id, name, active, config FROM news_profiles WHERE site_id = ?${opts.activeOnly ? " AND active = 1" : ""} ORDER BY sort, id`,
      [siteId],
    );
    return rows.map((r) => ({ id: r.id, siteId: r.site_id, name: r.name, active: r.active === 1, config: parseProfileConfig(parseJson(r.config, {})) }));
  }

  async getProfile(siteId: string, id: number): Promise<Profile | null> {
    return (await this.listProfiles(siteId)).find((p) => p.id === id) ?? null;
  }

  async createProfile(siteId: string, input: { name: string; active?: boolean; config?: unknown }): Promise<Profile> {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error("Profil braucht einen Namen");
    const config: ProfileConfig = parseProfileConfig(input.config);
    const now = this.now();
    const [res] = await this.pool.query<ResultSetHeader>(
      "INSERT INTO news_profiles (site_id, name, active, sort, config, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
      [siteId, name, input.active === false ? 0 : 1, JSON.stringify(config), now, now],
    );
    return { id: res.insertId, siteId, name, active: input.active !== false, config };
  }

  async updateProfile(siteId: string, id: number, input: { name?: string; active?: boolean; config?: unknown }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.name !== undefined) {
      sets.push("name = ?");
      vals.push(input.name.trim().slice(0, 80));
    }
    if (input.active !== undefined) {
      sets.push("active = ?");
      vals.push(input.active ? 1 : 0);
    }
    if (input.config !== undefined) {
      sets.push("config = ?");
      vals.push(JSON.stringify(parseProfileConfig(input.config)));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(this.now(), siteId, id);
    await this.pool.query(`UPDATE news_profiles SET ${sets.join(", ")} WHERE site_id = ? AND id = ?`, vals);
  }

  // ─── Queue: Duplikate und Anlegen ────────────────────────────────────────────────────────────

  async guidExists(siteId: string, guid: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT 1 FROM news_queue WHERE site_id = ? AND guid = ? LIMIT 1", [siteId, guid]);
    return rows.length > 0;
  }

  async urlHashExists(siteId: string, hash: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT 1 FROM news_queue WHERE site_id = ? AND url_hash = ? LIMIT 1", [siteId, hash]);
    return rows.length > 0;
  }

  /** Legt einen Eintrag mit Status `new` an. Liefert null, wenn die GUID schon existiert. */
  async insertEntry(e: NewEntry): Promise<number | null> {
    const now = this.now();
    try {
      const [res] = await this.pool.query<ResultSetHeader>(
        `INSERT INTO news_queue (site_id, profile_id, guid, url_hash, feed_url, source_url, source_name, source_list, title_original, published_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, ?, ?)`,
        [
          e.siteId,
          e.profileId,
          e.guid,
          e.urlHash,
          e.feedUrl.slice(0, 500),
          e.sourceUrl.slice(0, 1000),
          e.sourceName.slice(0, 191),
          e.sourceList ? JSON.stringify(e.sourceList) : null,
          e.titleOriginal,
          e.publishedAt,
          now,
          now,
        ],
      );
      return res.insertId;
    } catch (err) {
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") return null;
      throw err;
    }
  }

  // ─── Queue: Lesen und Ändern ─────────────────────────────────────────────────────────────────

  async getEntry(id: number): Promise<QueueEntry | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM news_queue WHERE id = ?", [id]);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  /** Älteste Einträge mit einem der Status, höchstens `limit` */
  async takeByStatus(siteId: string, statuses: QueueStatus[], limit: number, opts: { profileIds?: number[]; kind?: SourceKind } = {}): Promise<QueueEntry[]> {
    if (!statuses.length || limit < 1) return [];
    if (opts.profileIds && !opts.profileIds.length) return [];
    const params: unknown[] = [siteId, statuses];
    let sql = "SELECT * FROM news_queue WHERE site_id = ? AND status IN (?)";
    if (opts.profileIds) {
      sql += " AND profile_id IN (?)";
      params.push(opts.profileIds);
    }
    if (opts.kind) {
      sql += opts.kind === "brave" ? " AND feed_url = ?" : " AND feed_url <> ?";
      params.push(BRAVE_FEED_MARK);
    }
    sql += " ORDER BY created_at, id LIMIT ?";
    params.push(limit);
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows.map(rowToEntry);
  }

  async updateEntry(id: number, patch: EntryPatch): Promise<void> {
    const keys = Object.keys(patch) as (keyof EntryPatch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${COLUMN[k]} = ?`);
    const vals = keys.map((k) => toDb(k, patch[k]));
    await this.pool.query(`UPDATE news_queue SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...vals, this.now(), id]);
  }

  /**
   * Zentrale Fehlerbehandlung (KNP 1.12.0): Zähler +1; beim dritten Fehler sofort `rejected`,
   * sonst `failed` mit Rücksprung-Status für die Wiederholung.
   */
  async failEntry(entry: Pick<QueueEntry, "id" | "attempts">, retryStatus: QueueStatus, message: string): Promise<QueueStatus> {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.updateEntry(entry.id, {
        attempts,
        status: "rejected",
        retryStatus: null,
        error: `Nach ${MAX_ATTEMPTS} Fehlversuchen aussortiert. Letzter Fehler: ${message}`,
      });
      return "rejected";
    }
    await this.updateEntry(entry.id, { attempts, status: "failed", retryStatus, error: message });
    return "failed";
  }

  // ─── Queue: Aktionen der Redaktion (einzeln und als Sammel-Aktion) ───────────────────────────

  /** Freigeben: nur klassifizierte Einträge */
  async approve(siteId: string, ids: number[]): Promise<number> {
    return this.bulk(siteId, ids, "status = 'approved', error = NULL", "status = 'classified'");
  }

  /** Aussortieren (aus jedem Status außer veröffentlicht) */
  async reject(siteId: string, ids: number[], reason = "Von Hand aussortiert"): Promise<number> {
    if (!ids.length) return 0;
    const [res] = await this.pool.query<ResultSetHeader>(
      "UPDATE news_queue SET status = 'rejected', error = ?, updated_at = ? WHERE site_id = ? AND id IN (?) AND status <> 'published'",
      [clipError(reason), this.now(), siteId, ids],
    );
    return res.affectedRows;
  }

  /** Erneut versuchen: zurück auf `new`, Zähler 0, Fehler leer */
  async retry(siteId: string, ids: number[]): Promise<number> {
    return this.bulk(siteId, ids, "status = 'new', attempts = 0, error = NULL, retry_status = NULL", "status <> 'published'");
  }

  async remove(siteId: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const [res] = await this.pool.query<ResultSetHeader>("DELETE FROM news_queue WHERE site_id = ? AND id IN (?)", [siteId, ids]);
    return res.affectedRows;
  }

  async countByStatus(siteId: string): Promise<Record<QueueStatus, number>> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT status, COUNT(*) AS n FROM news_queue WHERE site_id = ? GROUP BY status", [siteId]);
    const out = Object.fromEntries(QUEUE_STATUSES.map((s) => [s, 0])) as Record<QueueStatus, number>;
    for (const r of rows) if (r.status in out) out[r.status as QueueStatus] = Number(r.n);
    return out;
  }

  private async bulk(siteId: string, ids: number[], set: string, where: string): Promise<number> {
    if (!ids.length) return 0;
    const [res] = await this.pool.query<ResultSetHeader>(`UPDATE news_queue SET ${set}, updated_at = ? WHERE site_id = ? AND id IN (?) AND ${where}`, [this.now(), siteId, ids]);
    return res.affectedRows;
  }
}

/** Store aus einer Datenbank-URL (eigener kleiner Pool in UTC) oder aus einem vorhandenen Pool */
export function createNewsStore(opts: { url: string; connectionLimit?: number } | { pool: Pool }, now?: () => Date): NewsStore {
  if ("pool" in opts) return new NewsStore(opts.pool, now);
  const pool = mysql.createPool({ uri: opts.url, timezone: "Z", connectionLimit: opts.connectionLimit ?? 4, charset: "utf8mb4_unicode_ci" });
  return new NewsStore(pool, now);
}
