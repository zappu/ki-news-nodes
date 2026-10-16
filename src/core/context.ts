import type { NewsStore } from "../store/store";
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
  now?: () => Date;
  random?: () => number;
}

/** Zustand eines Laufs: geladene Einstellungen und Profile, Protokoll */
export interface RunState {
  settings: SiteSettings;
  /** Alle Profile der Seite (auch inaktive, damit vorhandene Einträge weiterlaufen) */
  profiles: Map<number, Profile>;
  /** IDs der aktiven Profile, in Lauf-Reihenfolge */
  activeProfileIds: number[];
  logger: RunLogger;
  now: () => Date;
  random: () => number;
}

export interface StepResult {
  /** Eine Zeile fürs Protokoll */
  summary: string;
}
