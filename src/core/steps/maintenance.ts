/**
 * Tägliche Wartung (neu gegenüber KNP, gegen die volle Queue von kanzlei-reese.de):
 * Einmal am Tag ab `maintenanceHour` Ortszeit
 * - verfallen nicht freigegebene Einträge nach `expireDays` Tagen (Status `rejected`, Meldung „Abgelaufen“),
 *   ebenso Einträge, die so lange in `new`, `crawled` oder `failed` liegen,
 * - geht bei manueller Freigabe eine Hinweis-Mail an die Admins, wenn Artikel warten.
 */
import type { PipelineContext, RunState, StepResult } from "../context";
import { localTimeOnDay } from "../time";

const STATE_KEY = "maintenance_day";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function waitingMail(lines: { profile: string; count: number }[], total: number, adminUrl: string | null | undefined): { subject: string; text: string; html: string } {
  const subject = `${total} News-Artikel ${total === 1 ? "wartet" : "warten"} auf Freigabe`;
  const list = lines.map((l) => `${l.profile}: ${l.count}`).join("\n");
  const link = adminUrl ? `\n\nZur Queue: ${adminUrl}` : "";
  const text = `In der News-Queue ${total === 1 ? "wartet 1 Artikel" : `warten ${total} Artikel`} auf deine Freigabe.\n\n${list}${link}\n\nNicht freigegebene Artikel verfallen automatisch nach der eingestellten Frist.`;
  const html =
    `<p>In der News-Queue ${total === 1 ? "wartet <strong>1 Artikel</strong>" : `warten <strong>${total} Artikel</strong>`} auf deine Freigabe.</p>` +
    `<ul>${lines.map((l) => `<li>${esc(l.profile)}: ${l.count}</li>`).join("")}</ul>` +
    (adminUrl ? `<p><a href="${esc(adminUrl)}">Zur Queue</a></p>` : "") +
    "<p>Nicht freigegebene Artikel verfallen automatisch nach der eingestellten Frist.</p>";
  return { subject, text, html };
}

export async function maintenance(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  const now = run.now();
  const { settings } = run;
  if (now.getTime() < localTimeOnDay(now, settings.timezone, settings.maintenanceHour).getTime()) return { summary: `Wartung: heute ab ${settings.maintenanceHour} Uhr.` };
  if ((await ctx.store.getState(ctx.siteId, STATE_KEY)) === run.dayKey) return { summary: "Wartung: heute schon erledigt." };
  await ctx.store.setState(ctx.siteId, STATE_KEY, run.dayKey);

  const before = new Date(now.getTime() - settings.expireDays * 86_400_000);
  const expired = await ctx.store.expireEntries(ctx.siteId, before, { classified: settings.requireApproval, days: settings.expireDays });
  let mail = "keine Hinweis-Mail";
  if (settings.requireApproval && settings.notifyWaiting) {
    const waiting = await ctx.store.waitingByProfile(ctx.siteId);
    const total = [...waiting.values()].reduce((a, b) => a + b, 0);
    if (total > 0 && ctx.notify) {
      const lines = [...waiting].map(([id, count]) => ({ profile: run.profiles.get(id)?.name ?? `Profil ${id}`, count }));
      try {
        await ctx.notify(waitingMail(lines, total, ctx.adminUrl));
        mail = `Hinweis-Mail zu ${total} wartenden Artikeln gesendet`;
      } catch (e) {
        mail = `Hinweis-Mail fehlgeschlagen: ${(e as Error).message}`;
      }
    } else if (total > 0) {
      mail = `${total} Artikel warten, aber es ist kein Mailversand eingerichtet`;
    }
  }
  return { summary: `Wartung: ${expired.classified} nicht freigegebene und ${expired.stale} liegengebliebene Einträge abgelaufen, ${mail}.` };
}
