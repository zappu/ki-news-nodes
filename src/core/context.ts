import type { NewsStore, RunTrigger } from "../store/store";
import type { HttpClient } from "./http";
import type { Profile, SiteSettings } from "./settings";
import type { LlmFn, PublishTarget, RunLogger } from "./types";

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
}

export interface StepResult {
  /** Eine Zeile fürs Protokoll */
  summary: string;
}

/** Tageslimit erreicht: der Schritt endet regulär, der Rest folgt am nächsten Tag */
export class DailyLimitError extends Error {}
