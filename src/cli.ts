/**
 * Befehlszeile für das Cron-Skript der Zielseite (`node dist/scripts/news.js run`).
 * Die Seite baut den Kontext (Datenbank, KI-Kette, Ziel-Adapter) und übergibt ihn hier:
 *
 *   process.exitCode = await runCli(process.argv.slice(2), async () => ({ ctx, close }));
 *
 * Befehle: `migrate` (Tabellen anlegen), `run` (ein Lauf), `status` (Einträge je Status).
 */
import type { PipelineContext } from "./core/context";
import { runPipeline } from "./core/pipeline";
import { QUEUE_STATUSES } from "./core/types";

export interface CliEnvironment {
  ctx: PipelineContext;
  close(): Promise<void>;
}

export const CLI_USAGE = "Aufruf: news <migrate|run|status>";

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
      return 0;
    }
    const res = await runPipeline(ctx);
    for (const line of res.log) out(line);
    out(res.status === "completed" ? "Lauf abgeschlossen." : "Lauf mit Fehlern beendet.");
    return res.status === "completed" ? 0 : 1;
  } catch (e) {
    out(`Fehler: ${(e as Error).message}`);
    return 1;
  } finally {
    await env?.close().catch(() => undefined);
  }
}
