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

export interface TakeOptions {
  profileIds?: number[];
  excludeProfileIds?: number[];
  kind?: SourceKind;
}

export type RunTrigger = "cron" | "manual";
export type RunStatus = "running" | "completed" | "failed" | "locked";

export interface RunRow {
  id: number;
  siteId: string;
  trigger: RunTrigger;
  status: RunStatus;
  step: string | null;
  message: string | null;
  log: string[];
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** Wie viele Läufe je Seite aufbewahrt werden */
export const KEEP_RUNS = 500;

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
    | "classifiedAt"
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
  classifiedAt: "classified_at",
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
    classifiedAt: r.classified_at ?? null,
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
  async takeByStatus(siteId: string, statuses: QueueStatus[], limit: number, opts: TakeOptions = {}): Promise<QueueEntry[]> {
    if (!statuses.length || limit < 1) return [];
    const where = this.takeWhere(siteId, statuses, opts);
    if (!where) return [];
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM news_queue WHERE ${where.sql} ORDER BY created_at, id LIMIT ?`, [...where.params, limit]);
    return rows.map(rowToEntry);
  }

  /**
   * Wie `takeByStatus`, aber reihum über die Profile: erst der älteste Eintrag jedes Profils, dann der
   * zweitälteste usw. `profileOrder` bestimmt, welches Profil in jeder Runde zuerst drankommt; Profile,
   * die dort fehlen (z. B. inaktive), kommen danach.
   */
  async takeFair(siteId: string, statuses: QueueStatus[], limit: number, profileOrder: number[], opts: TakeOptions = {}): Promise<QueueEntry[]> {
    if (!statuses.length || limit < 1) return [];
    const where = this.takeWhere(siteId, statuses, opts);
    if (!where) return [];
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM (SELECT q.*, ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at, id) AS rr FROM news_queue q WHERE ${where.sql}) t WHERE rr <= ? ORDER BY rr, created_at, id`,
      [...where.params, limit],
    );
    const rank = (pid: number) => {
      const i = profileOrder.indexOf(pid);
      return i < 0 ? profileOrder.length + pid : i;
    };
    return rows
      .sort((a, b) => a.rr - b.rr || rank(a.profile_id) - rank(b.profile_id))
      .slice(0, limit)
      .map(rowToEntry);
  }

  private takeWhere(siteId: string, statuses: QueueStatus[], opts: TakeOptions): { sql: string; params: unknown[] } | null {
    if (opts.profileIds && !opts.profileIds.length) return null;
    const params: unknown[] = [siteId, statuses];
    let sql = "site_id = ? AND status IN (?)";
    if (opts.profileIds) {
      sql += " AND profile_id IN (?)";
      params.push(opts.profileIds);
    }
    if (opts.excludeProfileIds?.length) {
      sql += " AND profile_id NOT IN (?)";
      params.push(opts.excludeProfileIds);
    }
    if (opts.kind) {
      sql += opts.kind === "brave" ? " AND feed_url = ?" : " AND feed_url <> ?";
      params.push(BRAVE_FEED_MARK);
    }
    return { sql, params };
  }

  /** Original- und KI-Titel der letzten Queue-Einträge (für den Brave-Abgleich) */
  async recentQueueTitles(siteId: string, limit: number): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT title_original, rewritten_title FROM news_queue WHERE site_id = ? ORDER BY id DESC LIMIT ?", [siteId, limit]);
    return rows.flatMap((r) => [r.title_original, r.rewritten_title]).filter((t): t is string => typeof t === "string" && t.length > 0);
  }

  /** Heute schon angelegte Brave-Themen eines Profils */
  async countBraveSince(siteId: string, profileId: number, since: Date): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM news_queue WHERE site_id = ? AND profile_id = ? AND feed_url = ? AND created_at >= ?", [
      siteId,
      profileId,
      BRAVE_FEED_MARK,
      since,
    ]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Anzahl der seit `since` neu geschriebenen Einträge je Profil (für das Artikelziel pro Tag) */
  async countClassifiedSince(siteId: string, since: Date): Promise<Map<number, number>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT profile_id, COUNT(*) AS n FROM news_queue WHERE site_id = ? AND classified_at >= ? AND relevance = 1 GROUP BY profile_id",
      [siteId, since],
    );
    return new Map(rows.map((r) => [r.profile_id as number, Number(r.n)]));
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

  // ─── Läufe ───────────────────────────────────────────────────────────────────────────────────

  async startRun(siteId: string, trigger: RunTrigger, status: RunStatus = "running", message: string | null = null): Promise<number> {
    const now = this.now();
    const [res] = await this.pool.query<ResultSetHeader>(
      "INSERT INTO news_runs (site_id, trigger_kind, status, step, message, log, started_at, updated_at, finished_at) VALUES (?, ?, ?, NULL, ?, '[]', ?, ?, ?)",
      [siteId, trigger, status, message, now, now, status === "running" ? null : now],
    );
    return res.insertId;
  }

  async updateRun(id: number, patch: { status?: RunStatus; step?: string | null; message?: string | null; log?: string[]; finished?: boolean }): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [this.now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.step !== undefined) {
      sets.push("step = ?");
      vals.push(patch.step);
    }
    if (patch.message !== undefined) {
      sets.push("message = ?");
      vals.push(patch.message === null ? null : clipError(patch.message));
    }
    if (patch.log !== undefined) {
      sets.push("log = ?");
      vals.push(JSON.stringify(patch.log));
    }
    if (patch.finished) {
      sets.push("finished_at = ?");
      vals.push(this.now());
    }
    await this.pool.query(`UPDATE news_runs SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
  }

  async getRun(id: number): Promise<RunRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM news_runs WHERE id = ?", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listRuns(siteId: string, limit = 20): Promise<RunRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM news_runs WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT ?", [siteId, limit]);
    return rows.map(rowToRun);
  }

  /** Beginn des letzten Laufs, der tatsächlich gelaufen ist (gesperrte zählen nicht) */
  async lastRunStart(siteId: string): Promise<Date | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT started_at FROM news_runs WHERE site_id = ? AND status <> 'locked' ORDER BY started_at DESC, id DESC LIMIT 1", [siteId]);
    return rows[0]?.started_at ?? null;
  }

  /**
   * Läufe, die noch als `running` stehen, obwohl wir die Sperre halten: Ihr Prozess ist abgebrochen.
   * Sie werden als `failed` markiert, der letzte Schritt bleibt sichtbar.
   */
  async markStaleRuns(siteId: string, exceptId: number): Promise<number> {
    const [res] = await this.pool.query<ResultSetHeader>(
      "UPDATE news_runs SET status = 'failed', message = CONCAT('Abgebrochen (Prozess beendet) in Schritt ', COALESCE(step, '?')), finished_at = ?, updated_at = ? WHERE site_id = ? AND status = 'running' AND id <> ?",
      [this.now(), this.now(), siteId, exceptId],
    );
    return res.affectedRows;
  }

  /** Nur die neuesten `keep` Läufe je Seite behalten */
  async pruneRuns(siteId: string, keep = KEEP_RUNS): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT id FROM news_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?", [siteId, keep]);
    const border = rows[0]?.id;
    if (!border) return 0;
    const [res] = await this.pool.query<ResultSetHeader>("DELETE FROM news_runs WHERE site_id = ? AND id <= ?", [siteId, border]);
    return res.affectedRows;
  }

  // ─── Zähler für Tageslimits ──────────────────────────────────────────────────────────────────

  async getUsage(siteId: string, day: string, kind: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT count FROM news_usage WHERE site_id = ? AND day = ? AND kind = ?", [siteId, day, kind]);
    return rows[0] ? Number(rows[0].count) : 0;
  }

  async incrementUsage(siteId: string, day: string, kind: string, by = 1): Promise<void> {
    await this.pool.query("INSERT INTO news_usage (site_id, day, kind, count) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE count = count + VALUES(count)", [siteId, day, kind, by]);
  }

  // ─── Zustand (kleine Schlüssel-Wert-Paare je Seite) ──────────────────────────────────────────

  async getState(siteId: string, key: string): Promise<string | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT v FROM news_state WHERE site_id = ? AND k = ?", [siteId, key]);
    return rows[0]?.v ?? null;
  }

  async setState(siteId: string, key: string, value: string | null): Promise<void> {
    await this.pool.query("INSERT INTO news_state (site_id, k, v, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)", [siteId, key, value, this.now()]);
  }

  // ─── Lauf-Sperre ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sperre je Seite über `GET_LOCK` auf einer eigenen Verbindung (wie KNP 1.7.3). Bricht der Prozess ab,
   * schließt die Datenbank die Verbindung und die Sperre ist frei. Liefert null, wenn ein anderer Lauf
   * sie hält.
   */
  async acquireRunLock(siteId: string): Promise<RunLock | null> {
    const name = lockName(siteId);
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS ok", [name]);
      if (rows[0]?.ok !== 1) {
        conn.release();
        return null;
      }
    } catch (e) {
      conn.release();
      throw e;
    }
    let released = false;
    return {
      async stillHeld() {
        if (released) return false;
        try {
          const [rows] = await conn.query<RowDataPacket[]>("SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine", [name]);
          return rows[0]?.mine === 1;
        } catch {
          return false;
        }
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await conn.query("SELECT RELEASE_LOCK(?)", [name]);
        } finally {
          conn.release();
        }
      },
    };
  }

  private async bulk(siteId: string, ids: number[], set: string, where: string): Promise<number> {
    if (!ids.length) return 0;
    const [res] = await this.pool.query<ResultSetHeader>(`UPDATE news_queue SET ${set}, updated_at = ? WHERE site_id = ? AND id IN (?) AND ${where}`, [this.now(), siteId, ids]);
    return res.affectedRows;
  }
}

export interface RunLock {
  /** Heartbeat: hält diese Verbindung die Sperre noch? */
  stillHeld(): Promise<boolean>;
  release(): Promise<void>;
}

/** Name der Sperre je Seite; MySQL erlaubt höchstens 64 Zeichen */
function lockName(siteId: string): string {
  return ("news_run_" + siteId).slice(0, 64);
}

function rowToRun(r: RowDataPacket): RunRow {
  return {
    id: r.id,
    siteId: r.site_id,
    trigger: r.trigger_kind === "manual" ? "manual" : "cron",
    status: r.status as RunStatus,
    step: r.step,
    message: r.message,
    log: parseJson<string[]>(r.log, []),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

/** Store aus einer Datenbank-URL (eigener kleiner Pool in UTC) oder aus einem vorhandenen Pool */
export function createNewsStore(opts: { url: string; connectionLimit?: number } | { pool: Pool }, now?: () => Date): NewsStore {
  if ("pool" in opts) return new NewsStore(opts.pool, now);
  const pool = mysql.createPool({ uri: opts.url, timezone: "Z", connectionLimit: opts.connectionLimit ?? 4, charset: "utf8mb4_unicode_ci" });
  return new NewsStore(pool, now);
}
