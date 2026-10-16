/**
 * Ein Lauf: Einstellungen und Profile laden, dann die Schritte in der Reihenfolge aus KNP 1.12.1.
 * Version 0.1.0 enthält Veröffentlichung, RSS-Import, Crawl und KI. Sperre, Laufprotokoll in der
 * Datenbank, Fehlerwiederholung und Zeitbudget folgen mit 0.2.0, Brave mit 0.3.0, Bilder mit 0.4.0.
 */
import type { PipelineContext, RunState, StepResult } from "./context";
import { classify } from "./steps/classify";
import { crawl } from "./steps/crawl";
import { importFeeds } from "./steps/importFeeds";
import { publish } from "./steps/publish";

export interface RunResult {
  status: "completed" | "failed";
  log: string[];
}

type Step = { name: string; fn: (ctx: PipelineContext, run: RunState) => Promise<StepResult> };

/** Reihenfolge: Veröffentlichung läuft bewusst früh (KNP 1.8.0) */
export const STEPS: Step[] = [
  { name: "Veröffentlichung", fn: publish },
  { name: "RSS-Import", fn: importFeeds },
  { name: "Crawl", fn: crawl },
  { name: "KI", fn: classify },
];

export async function runPipeline(ctx: PipelineContext): Promise<RunResult> {
  const now = ctx.now ?? (() => new Date());
  const lines: string[] = [];
  const logger = { log: (line: string) => lines.push(line) };
  const settings = await ctx.store.getSettings(ctx.siteId);
  const all = await ctx.store.listProfiles(ctx.siteId);
  const run: RunState = {
    settings,
    profiles: new Map(all.map((p) => [p.id, p])),
    activeProfileIds: all.filter((p) => p.active).map((p) => p.id),
    logger,
    now,
    random: ctx.random ?? Math.random,
  };
  if (!run.activeProfileIds.length) logger.log("Hinweis: kein aktives Profil, es werden keine neuen Meldungen gesucht.");

  let failed = false;
  for (const step of STEPS) {
    try {
      const res = await step.fn(ctx, run);
      logger.log(res.summary);
    } catch (e) {
      failed = true;
      logger.log(`${step.name}: Schritt abgebrochen: ${(e as Error).message}`);
    }
  }
  return { status: failed ? "failed" : "completed", log: lines };
}
