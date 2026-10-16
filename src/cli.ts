/**
 * Befehlszeile für das Cron-Skript der Zielseite (`node dist/scripts/news.js run`).
 * Die Seite baut den Kontext (Datenbank, KI-Kette, Ziel-Adapter) und übergibt ihn hier:
 *
 *   process.exitCode = await runCli(process.argv.slice(2), async () => ({ ctx, close }));
 *
 * Befehle: `migrate` (Tabellen anlegen), `run` (Lauf, wenn laut Intervall fällig), `run --force`
 * (sofort, gilt als manueller Lauf), `status` (Einträge je Status und letzter Lauf).
 * Plesk-Cron ruft `run` alle 15 Minuten auf; das Intervall aus den Einstellungen entscheidet, ob wirklich
 * ein Lauf startet (Entscheidung 0002).
 */
import type { PipelineContext } from "./core/context";
import { isRunDue, runPipeline } from "./core/pipeline";
import { QUEUE_STATUSES } from "./core/types";

export interface CliEnvironment {
  ctx: PipelineContext;
  close(): Promise<void>;
}

export const CLI_USAGE = "Aufruf: news <migrate|run [--force]|status>";

export async function runCli(argv: string[], build: () => Promise<CliEnvironment>, out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const cmd = argv[0];
  if (cmd !== "migrate" && cmd !== "run" && cmd !== "status") {
    out(CLI_USAGE);
    return 2;
  }
  let env: CliEnvironment | null = null;
  try {
    env = await build();
    const { ctx } = env;
    if (cmd === "migrate") {
      const applied = await ctx.store.migrate();
      out(applied.length ? `Migrationen ausgeführt: ${applied.join(", ")}` : "Datenbank ist aktuell.");
      return 0;
    }
    await ctx.store.migrate();
    if (cmd === "status") {
      const counts = await ctx.store.countByStatus(ctx.siteId);
      out(QUEUE_STATUSES.map((s) => `${s}: ${counts[s]}`).join(", "));
      const [last] = await ctx.store.listRuns(ctx.siteId, 1);
      out(last ? `Letzter Lauf: ${last.startedAt.toISOString()} ${last.status}${last.step ? ` (Schritt ${last.step})` : ""}${last.message ? `: ${last.message}` : ""}` : "Noch kein Lauf.");
      return 0;
    }
    const force = argv.includes("--force");
    if (!force) {
      const settings = await ctx.store.getSettings(ctx.siteId);
      const last = await ctx.store.lastRunStart(ctx.siteId);
      const now = (ctx.now ?? (() => new Date()))();
      if (!isRunDue(last, settings.cronInterval, now)) {
        out(`Noch nicht fällig (Intervall ${settings.cronInterval}, letzter Lauf ${last!.toISOString()}).`);
        return 0;
      }
    }
    const res = await runPipeline(ctx, { trigger: force ? "manual" : "cron" });
    for (const line of res.log) out(line);
    if (res.status === "locked") {
      out("Übersprungen.");
      return 0;
    }
    out(res.status === "completed" ? "Lauf abgeschlossen." : "Lauf mit Fehlern beendet.");
    return res.status === "completed" ? 0 : 1;
  } catch (e) {
    out(`Fehler: ${(e as Error).message}`);
    return 1;
  } finally {
    await env?.close().catch(() => undefined);
  }
}
