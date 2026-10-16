import type { NewsStore, RunTrigger } from "../store/store";
import type { HttpClient } from "./http";
import type { Profile, SiteSettings } from "./settings";
import type { LlmFn, PublishTarget, RunLogger } from "./types";
import type { BraveSession } from "./steps/braveDiscover";

/** Alles, was ein Lauf von außen bekommt */
export interface PipelineContext {
  siteId: string;
  store: NewsStore;
  http: HttpClient;
  /** KI-Aufruf der Zielseite; null, wenn kein Schlüssel hinterlegt ist */
  llm: LlmFn | null;
  target: PublishTarget;
  /** Uhr für fachliche Zeiten (Datumsfenster, Tagesgrenzen); in Tests fest */
  now?: () => Date;
  random?: () => number;
  /** Zeitbudget der Veröffentlichung je Lauf, Standard 120 s (KNP 1.8.1) */
  publishBudgetMs?: number;
  /** Brave-Schlüssel aus der `.env` der Seite (`BRAVE_API_KEY`); ohne ihn keine Themensuche und keine Nachsuche */
  braveApiKey?: string | null;
  /** Warten (für die Pause zwischen Brave-Anfragen); in Tests ersetzbar */
  sleep?: (ms: number) => Promise<void>;
}

/** Zustand eines Laufs: geladene Einstellungen und Profile, Protokoll */
export interface RunState {
  runId: number;
  trigger: RunTrigger;
  settings: SiteSettings;
  /** Alle Profile der Seite (auch inaktive, damit vorhandene Einträge weiterlaufen) */
  profiles: Map<number, Profile>;
  /** IDs der aktiven Profile in der Reihenfolge dieses Laufs (wechselt von Lauf zu Lauf) */
  activeProfileIds: number[];
  logger: RunLogger;
  now: () => Date;
  random: () => number;
  /** Beginn des heutigen Tages in der Zeitzone der Seite (UTC) */
  dayStart: Date;
  /** Heutiger Tag als `JJJJ-MM-TT` in der Zeitzone der Seite */
  dayKey: string;
  /** KI-Aufruf mit Tageslimit; null ohne Schlüssel */
  llm: LlmFn | null;
  /** Brave-Zugang mit Tageslimit und Pause; null ohne Brave-Schlüssel */
  brave: BraveSession | null;
}

export interface StepResult {
  /** Eine Zeile fürs Protokoll */
  summary: string;
}

/** Tageslimit erreicht: der Schritt endet regulär, der Rest folgt am nächsten Tag */
export class DailyLimitError extends Error {}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
