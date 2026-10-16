/**
 * Einstellungen der Zielseite und der Profile, geprüft mit zod. Fehlende Felder bekommen die
 * Standardwerte aus KNP 1.12.1 bzw. aus dem Projektplan; Werte außerhalb des Bereichs werden begrenzt.
 */
import { z } from "zod";
import { LENGTH_TIER_NAMES, type LengthTier } from "./lengths";
import { DEFAULT_AI_DISCLOSURE } from "./prompts";
import { isValidTimeZone } from "./time";

const clampInt = (min: number, max: number, def: number) =>
  z
    .unknown()
    .transform((v) => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) return def;
      return Math.min(max, Math.max(min, Math.round(n)));
    });

const bool = (def: boolean) => z.unknown().transform((v) => (typeof v === "boolean" ? v : v === undefined || v === null ? def : v === "1" || v === "true" || v === 1));

const str = (def: string, max = 20_000) => z.unknown().transform((v) => (typeof v === "string" ? v.slice(0, max) : def));

const tiers = (def: LengthTier[]) =>
  z.unknown().transform((v) => {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    const clean = arr.map((x) => String(x).trim()).filter((x): x is LengthTier => (LENGTH_TIER_NAMES as string[]).includes(x));
    return clean.length ? [...new Set(clean)] : def;
  });

/** Zeilen- oder Listeneingabe zu einer Liste ohne leere Einträge */
const lines = z.unknown().transform((v) => {
  const arr = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/\r?\n/) : [];
  return arr.map((x) => x.trim()).filter(Boolean);
});

const nullableId = z.unknown().transform((v) => (typeof v === "number" && v > 0 ? Math.round(v) : null));
const nullableStr = z.unknown().transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null));

export const CRON_INTERVALS = { "15min": 15, "30min": 30, hourly: 60, twicedaily: 720, daily: 1440 } as const;
export type CronInterval = keyof typeof CRON_INTERVALS;

export const siteSettingsSchema = z.object({
  language: str("Deutsch", 100),
  /** Zeitzone der Seite für Tagesgrenzen und Brave-Zeitplan */
  timezone: z.unknown().transform((v) => (typeof v === "string" && v.trim() && isValidTimeZone(v.trim()) ? v.trim() : "Europe/Berlin")),
  imagesEnabled: bool(false),
  imageModel: str("fal-ai/flux/schnell", 200),
  requireApproval: bool(true),
  postStatus: z.unknown().transform((v) => (v === "draft" ? "draft" : "published") as "draft" | "published"),
  author: nullableStr,
  addSourceLink: bool(true),
  aiDisclosure: str(DEFAULT_AI_DISCLOSURE, 1000),
  tagsEnabled: bool(true),
  maxTags: clampInt(3, 10, 6),
  maxPerRun: clampInt(1, 25, 5),
  cronInterval: z.unknown().transform((v) => (typeof v === "string" && v in CRON_INTERVALS ? (v as CronInterval) : "hourly")),
  /** Kategorie für unbekannte KI-Antworten (Entscheidung 0004) */
  fallbackCategory: str("News", 128),
  /** Tageslimit KI-Aufrufe je Seite, 0 = ohne Limit (Phase 2) */
  dailyAiLimit: clampInt(0, 10_000, 60),
  /** Tageslimit Brave-Anfragen je Seite, 0 = ohne Limit */
  dailyBraveLimit: clampInt(0, 10_000, 200),
  /** Pause zwischen Brave-Anfragen; 1100 ms für den Gratis-Tarif (1 Anfrage/s), bezahlte Tarife vertragen weniger */
  braveDelayMs: clampInt(0, 5000, 1100),
  /** Tageslimit Bilder je Seite, 0 = ohne Limit (Phase 4) */
  dailyImageLimit: clampInt(0, 10_000, 20),
  /** Nicht freigegebene Einträge verfallen nach so vielen Tagen (Phase 5) */
  expireDays: clampInt(1, 90, 14),
});
export type SiteSettings = z.output<typeof siteSettingsSchema>;

export const profileConfigSchema = z.object({
  topicPrompt: str("", 20_000),
  feeds: lines,
  importWindow: clampInt(1, 7, 2),
  rssLengths: tiers(["short", "medium"]),
  braveEnabled: bool(false),
  braveQueries: lines,
  braveDays: clampInt(1, 14, 3),
  bravePerDay: clampInt(1, 48, 3),
  braveStartHour: clampInt(0, 23, 8),
  braveEndHour: clampInt(1, 24, 22),
  braveCompareUrls: lines,
  bravePrompt: str("", 20_000),
  braveLengths: tiers(["medium", "long"]),
  braveStructure: str("", 5_000),
  styleRss: nullableId,
  styleBrave: nullableId,
  /** Feste Kategorie (Name laut Zielseite); dann wählt die KI keine */
  fixedCategory: nullableStr,
  /** Artikelziel pro Tag (Phase 2) */
  dailyTarget: clampInt(1, 50, 3),
});
export type ProfileConfig = z.output<typeof profileConfigSchema>;

/** Alle Schlüssel des Schemas setzen (fehlende als null), damit die Standardwerte greifen */
function complete(shape: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.keys(shape).map((k) => [k, src[k] ?? null]));
}

export function parseSiteSettings(raw: unknown): SiteSettings {
  return siteSettingsSchema.parse(complete(siteSettingsSchema.shape, raw));
}

export function parseProfileConfig(raw: unknown): ProfileConfig {
  const cfg = profileConfigSchema.parse(complete(profileConfigSchema.shape, raw));
  if (cfg.braveEndHour <= cfg.braveStartHour) cfg.braveEndHour = Math.min(24, cfg.braveStartHour + 1);
  return cfg;
}

export interface Profile {
  id: number;
  siteId: string;
  name: string;
  active: boolean;
  config: ProfileConfig;
}
