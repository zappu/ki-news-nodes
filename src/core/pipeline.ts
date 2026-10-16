/**
 * Ein Lauf: Sperre holen, Lauf-Zeile anlegen, Einstellungen und Profile laden, dann die Schritte in der
 * Reihenfolge aus KNP 1.12.1. Vor jedem Schritt prüft ein Heartbeat die Sperre; Status und Protokoll
 * werden vor und nach jedem Schritt gespeichert, damit bei einem Absturz sichtbar bleibt, wo es hing.
 * Brave folgt mit 0.3.0, Bilder mit 0.4.0.
 */
import type { RunTrigger } from "../store/store";
import { DailyLimitError, type PipelineContext, type RunState, type StepResult } from "./context";
import { classify } from "./steps/classify";
import { crawl } from "./steps/crawl";
import { importFeeds } from "./steps/importFeeds";
import { publish } from "./steps/publish";
import { retryFailed } from "./steps/retry";
import { localDayKey, startOfLocalDay } from "./time";
import type { LlmFn } from "./types";
import { CRON_INTERVALS, type CronInterval } from "./settings";

export interface RunOptions {
  trigger?: RunTrigger;
}

export interface RunResult {
  status: "completed" | "failed" | "locked";
  runId: number;
  log: string[];
}

type Step = { name: string; fn: (ctx: PipelineContext, run: RunState) => Promise<StepResult> };

/** Reihenfolge: Fehlerwiederholung, dann Veröffentlichung bewusst früh (KNP 1.8.0) */
export const STEPS: Step[] = [
  { name: "Wiederholung", fn: retryFailed },
  { name: "Veröffentlichung", fn: publish },
  { name: "RSS-Import", fn: importFeeds },
  { name: "Crawl", fn: crawl },
  { name: "KI", fn: classify },
];

/** Reihenfolge der Profile in diesem Lauf: jeder Lauf beginnt beim nächsten Profil */
export function rotate<T>(list: T[], offset: number): T[] {
  if (!list.length) return [];
  const k = ((offset % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/** Ist laut Intervall ein Lauf fällig? Zwei Minuten Spielraum, weil Cron-Läufe nie auf die Sekunde starten. */
export function isRunDue(lastStart: Date | null, interval: CronInterval, now: Date, slackMs = 120_000): boolean {
  if (!lastStart) return true;
  return now.getTime() - lastStart.getTime() >= CRON_INTERVALS[interval] * 60_000 - slackMs;
}

/** KI-Aufruf mit Tageslimit je Seite; jeder Aufruf zählt, auch ein fehlgeschlagener */
function limitedLlm(ctx: PipelineContext, run: Pick<RunState, "settings" | "dayKey">): LlmFn | null {
  const inner = ctx.llm;
  if (!inner) return null;
  const limit = run.settings.dailyAiLimit;
  return async (req) => {
    if (limit > 0) {
      const used = await ctx.store.getUsage(ctx.siteId, run.dayKey, "ai");
      if (used >= limit) throw new DailyLimitError(`Tageslimit von ${limit} KI-Aufrufen erreicht, weiter morgen`);
    }
    await ctx.store.incrementUsage(ctx.siteId, run.dayKey, "ai");
    return inner(req);
  };
}

export async function runPipeline(ctx: PipelineContext, opts: RunOptions = {}): Promise<RunResult> {
  const trigger = opts.trigger ?? "cron";
  const { store, siteId } = ctx;
  const lock = await store.acquireRunLock(siteId);
  if (!lock) {
    const msg = "Ein anderer Lauf ist noch aktiv, dieser wurde übersprungen.";
    const runId = await store.startRun(siteId, trigger, "locked", msg);
    return { status: "locked", runId, log: [msg] };
  }

  const lines: string[] = [];
  const logger = { log: (line: string) => lines.push(line) };
  let runId = 0;
  try {
    runId = await store.startRun(siteId, trigger);
    const stale = await store.markStaleRuns(siteId, runId);
    if (stale) logger.log(`Hinweis: ${stale} abgebrochene${stale === 1 ? "r" : ""} Lauf als fehlgeschlagen markiert.`);

    const now = ctx.now ?? (() => new Date());
    const settings = await store.getSettings(siteId);
    const all = await store.listProfiles(siteId);
    const offset = Number((await store.getState(siteId, "profile_offset")) ?? 0) || 0;
    await store.setState(siteId, "profile_offset", String(offset + 1));
    const start = now();
    const run: RunState = {
      runId,
      trigger,
      settings,
      profiles: new Map(all.map((p) => [p.id, p])),
      activeProfileIds: rotate(
        all.filter((p) => p.active).map((p) => p.id),
        offset,
      ),
      logger,
      now,
      random: ctx.random ?? Math.random,
      dayStart: startOfLocalDay(start, settings.timezone),
      dayKey: localDayKey(start, settings.timezone),
      llm: null,
    };
    run.llm = limitedLlm(ctx, run);
    if (!run.activeProfileIds.length) logger.log("Hinweis: kein aktives Profil, es werden keine neuen Meldungen gesucht.");

    let failed = false;
    for (const step of STEPS) {
      if (!(await lock.stillHeld())) {
        failed = true;
        logger.log(`Sperre verloren vor Schritt ${step.name}, Lauf abgebrochen.`);
        break;
      }
      await store.updateRun(runId, { step: step.name, log: lines });
      try {
        const res = await step.fn(ctx, run);
        logger.log(res.summary);
      } catch (e) {
        failed = true;
        logger.log(`${step.name}: Schritt abgebrochen: ${(e as Error).message}`);
      }
      await store.updateRun(runId, { log: lines });
    }

    const status = failed ? "failed" : "completed";
    await store.updateRun(runId, { status, step: null, message: failed ? "Lauf mit Fehlern beendet." : "Lauf abgeschlossen.", log: lines, finished: true });
    await store.pruneRuns(siteId);
    return { status, runId, log: lines };
  } catch (e) {
    logger.log(`Lauf abgebrochen: ${(e as Error).message}`);
    if (runId) await store.updateRun(runId, { status: "failed", message: (e as Error).message, log: lines, finished: true }).catch(() => undefined);
    return { status: "failed", runId, log: lines };
  } finally {
    await lock.release();
  }
}
