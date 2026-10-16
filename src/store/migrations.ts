/**
 * Versionierte Migrationen für die Tabellen des Pakets (Präfix `news_`) in der Datenbank der Zielseite.
 * Neue Änderungen immer als neue Version anhängen, nie eine bestehende ändern.
 * Alle Zeiten in UTC.
 */
import type { Pool, PoolConnection } from "mysql2/promise";

export interface Migration {
  version: number;
  name: string;
  sql: string[];
}

const T = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "Grundtabellen",
    sql: [
      `CREATE TABLE IF NOT EXISTS news_queue (
        id INT NOT NULL AUTO_INCREMENT,
        site_id VARCHAR(64) NOT NULL,
        profile_id INT NOT NULL,
        guid VARCHAR(64) NOT NULL,
        url_hash CHAR(32) NULL,
        feed_url VARCHAR(500) NOT NULL,
        source_url VARCHAR(1000) NOT NULL,
        source_name VARCHAR(191) NOT NULL DEFAULT '',
        source_list MEDIUMTEXT NULL,
        title_original TEXT NOT NULL,
        published_at DATETIME NULL,
        full_content MEDIUMTEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        relevance TINYINT NULL,
        rewritten_title TEXT NULL,
        rewritten_content MEDIUMTEXT NULL,
        teaser_text TEXT NULL,
        seo_title TEXT NULL,
        seo_description TEXT NULL,
        category_key VARCHAR(128) NULL,
        tags TEXT NULL,
        image_briefing TEXT NULL,
        image_ref VARCHAR(500) NULL,
        post_ref VARCHAR(191) NULL,
        error TEXT NULL,
        attempts INT NOT NULL DEFAULT 0,
        retry_status VARCHAR(20) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_news_queue_guid (site_id, guid),
        KEY idx_news_queue_url (site_id, url_hash),
        KEY idx_news_queue_status (site_id, status, created_at),
        KEY idx_news_queue_profile (site_id, profile_id)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_profiles (
        id INT NOT NULL AUTO_INCREMENT,
        site_id VARCHAR(64) NOT NULL,
        name VARCHAR(80) NOT NULL,
        active TINYINT NOT NULL DEFAULT 1,
        sort INT NOT NULL DEFAULT 0,
        config MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_news_profiles_name (site_id, name)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_settings (
        site_id VARCHAR(64) NOT NULL,
        config MEDIUMTEXT NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (site_id)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_styles (
        id INT NOT NULL AUTO_INCREMENT,
        site_id VARCHAR(64) NOT NULL,
        name VARCHAR(80) NOT NULL,
        instruction TEXT NOT NULL,
        sample MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_news_styles_name (site_id, name)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_runs (
        id INT NOT NULL AUTO_INCREMENT,
        site_id VARCHAR(64) NOT NULL,
        trigger_kind VARCHAR(12) NOT NULL,
        status VARCHAR(12) NOT NULL,
        step VARCHAR(60) NULL,
        message TEXT NULL,
        log MEDIUMTEXT NULL,
        started_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        finished_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_news_runs_site (site_id, started_at)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_usage (
        site_id VARCHAR(64) NOT NULL,
        day DATE NOT NULL,
        kind VARCHAR(20) NOT NULL,
        count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (site_id, day, kind)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS news_state (
        site_id VARCHAR(64) NOT NULL,
        k VARCHAR(64) NOT NULL,
        v TEXT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (site_id, k)
      ) ${T}`,
    ],
  },
  {
    version: 2,
    name: "Zeitpunkt des KI-Rewrites",
    sql: [
      "ALTER TABLE news_queue ADD COLUMN classified_at DATETIME NULL AFTER retry_status",
      "ALTER TABLE news_queue ADD KEY idx_news_queue_classified (site_id, profile_id, classified_at)",
    ],
  },
  {
    version: 3,
    name: "Zuordnung Queue-Eintrag zu Beitrag",
    sql: [
      `CREATE TABLE IF NOT EXISTS news_post_links (
        site_id VARCHAR(64) NOT NULL,
        queue_id INT NOT NULL,
        post_ref VARCHAR(191) NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (site_id, queue_id)
      ) ${T}`,
    ],
  },
];

/**
 * MySQL führt DDL ohne Transaktion aus: Bricht ein Prozess zwischen `ALTER TABLE` und dem Eintrag in
 * `news_migrations` ab, wäre die Spalte schon da und jede weitere Migration scheiterte. Deshalb gelten
 * „Tabelle/Spalte/Schlüssel gibt es schon“ als erledigt.
 */
const ALREADY_DONE = new Set([1050, 1060, 1061]); // ER_TABLE_EXISTS_ERROR, ER_DUP_FIELDNAME, ER_DUP_KEYNAME

async function runIdempotent(conn: PoolConnection, stmt: string): Promise<void> {
  try {
    await conn.query(stmt);
  } catch (e) {
    if (ALREADY_DONE.has((e as { errno?: number }).errno ?? 0)) return;
    throw e;
  }
}

/** Führt fehlende Migrationen aus. Mehrere Prozesse gleichzeitig sind durch eine Datenbank-Sperre geschützt. */
export async function migrate(pool: Pool): Promise<number[]> {
  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK('news_migrate', 30) AS ok");
    if ((lockRows as { ok: number | null }[])[0]?.ok !== 1) throw new Error("Migration: Sperre nicht erhalten");
    try {
      await conn.query(`CREATE TABLE IF NOT EXISTS news_migrations (version INT NOT NULL, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL, PRIMARY KEY (version)) ${T}`);
      const [rows] = await conn.query("SELECT version FROM news_migrations");
      const done = new Set((rows as { version: number }[]).map((r) => r.version));
      const applied: number[] = [];
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        for (const stmt of m.sql) await runIdempotent(conn, stmt);
        await conn.query("INSERT INTO news_migrations (version, name, applied_at) VALUES (?, ?, UTC_TIMESTAMP())", [m.version, m.name]);
        applied.push(m.version);
      }
      return applied;
    } finally {
      await conn.query("SELECT RELEASE_LOCK('news_migrate')");
    }
  } finally {
    conn.release();
  }
}
