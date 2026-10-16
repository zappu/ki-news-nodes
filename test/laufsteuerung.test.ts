/**
 * Phase 2: Sperre, Laufprotokoll, Fehlerwiederholung, Zeitbudget, Intervall, Profile reihum,
 * Artikelziel pro Tag, Tageslimit und Tagesgrenzen in der Zeitzone der Seite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import type { PipelineContext } from "../src/core/context";
import { isRunDue, rotate, runPipeline } from "../src/core/pipeline";
import { retryTarget } from "../src/core/steps/retry";
import { localDayKey, localTimeOnDay, startOfLocalDay } from "../src/core/time";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";
import { articleHtml, createFakeHttp, createFakeLlm, createMemoryTarget, relevantAnswer, rssXml } from "./helpers/fakes";

const SITE = "sft";
let clock = new Date("2026-10-16T10:00:00Z");
let store: NewsStore;

beforeEach(async () => {
  clock = new Date("2026-10-16T10:00:00Z");
  store = await freshStore(() => clock);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
});

const LONG = "Neue Funktionen für Läufer und Radfahrer im Überblick. ".repeat(8);

/** Feeds a.test und b.test mit je drei Meldungen, alle Quellseiten lesbar außer /kaputt */
function setup(extra: Partial<PipelineContext> = {}, llmAnswer: () => string = () => relevantAnswer()) {
  const routes: Record<string, { status?: number; body: string }> = {};
  for (const host of ["a", "b"]) {
    const items = [1, 2, 3].map((n) => ({ title: `${host.toUpperCase()} Meldung ${n}`, link: `https://${host}.test/m${n}`, guid: `${host}-${n}`, date: "Fri, 16 Oct 2026 08:00:00 GMT" }));
    routes[`https://${host}.test/rss`] = { body: rssXml(`Feed ${host}`, items) };
    for (const n of [1, 2, 3]) routes[`https://${host}.test/m${n}`] = { body: articleHtml(LONG + host + n) };
  }
  routes["https://k.test/rss"] = { body: rssXml("Kaputt", [{ title: "Weg", link: "https://k.test/kaputt", guid: "k-1", date: "Fri, 16 Oct 2026 08:00:00 GMT" }]) };
  routes["https://k.test/kaputt"] = { status: 410, body: "" };
  const http = createFakeHttp(routes);
  const llm = createFakeLlm(llmAnswer);
  const target = createMemoryTarget();
  const ctx: PipelineContext = { siteId: SITE, store, http: http.client, llm: llm.fn, target: target.target, now: () => clock, random: () => 0, ...extra };
  return { ctx, llm, target };
}

const prof = (name: string, config: Record<string, unknown>) => store.createProfile(SITE, { name, config: { topicPrompt: "Wearables", ...config } });

describe("Sperre und Laufprotokoll", () => {
  it("speichert Status, Schritt und Protokoll des Laufs", async () => {
    await prof("A", { feeds: ["https://a.test/rss"] });
    const { ctx } = setup();
    const res = await runPipeline(ctx, { trigger: "manual" });
    expect(res.status).toBe("completed");
    const run = (await store.getRun(res.runId))!;
    expect(run).toMatchObject({ status: "completed", trigger: "manual", step: null, message: "Lauf abgeschlossen." });
    expect(run.finishedAt).not.toBeNull();
    expect(run.log).toEqual(res.log);
    expect(run.log.find((l) => l.startsWith("Wiederholung:"))).toBe("Wiederholung: keine Fehlversuche.");
  });

  it("überspringt einen Lauf, solange ein anderer die Sperre hält", async () => {
    const { ctx } = setup();
    const lock = (await store.acquireRunLock(SITE))!;
    const res = await runPipeline(ctx);
    expect(res.status).toBe("locked");
    expect((await store.getRun(res.runId))!.status).toBe("locked");
    // andere Seite ist nicht betroffen
    expect((await runPipeline({ ...ctx, siteId: "andere" })).status).toBe("completed");
    await lock.release();
    expect((await runPipeline(ctx)).status).toBe("completed");
  });

  it("die Sperre ist nach einem Lauf wieder frei", async () => {
    const { ctx } = setup();
    await runPipeline(ctx);
    const lock = await store.acquireRunLock(SITE);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it("markiert liegengebliebene Läufe als abgebrochen", async () => {
    const stale = await store.startRun(SITE, "cron");
    await store.updateRun(stale, { step: "KI" });
    const { ctx } = setup();
    const res = await runPipeline(ctx);
    expect(res.log[0]).toBe("Hinweis: 1 abgebrochener Lauf als fehlgeschlagen markiert.");
    expect(await store.getRun(stale)).toMatchObject({ status: "failed", message: "Abgebrochen (Prozess beendet) in Schritt KI" });
  });

  it("bricht ab, wenn die Sperre verloren geht", async () => {
    let calls = 0;
    vi.spyOn(store, "acquireRunLock").mockResolvedValue({ stillHeld: async () => ++calls < 3, release: async () => undefined });
    const { ctx } = setup();
    const res = await runPipeline(ctx);
    expect(res.status).toBe("failed");
    expect(res.log.at(-1)).toBe("Sperre verloren vor Schritt Veröffentlichung, Lauf abgebrochen.");
    expect((await store.getRun(res.runId))!.status).toBe("failed");
  });

  it("hebt nur die neuesten Läufe auf", async () => {
    for (let i = 0; i < 5; i++) await store.startRun(SITE, "cron", "completed");
    expect(await store.pruneRuns(SITE, 2)).toBe(3);
    expect(await store.listRuns(SITE)).toHaveLength(2);
  });
});

describe("Fehlerwiederholung", () => {
  it("Rücksprung aus retry_status, sonst aus dem Präfix der Meldung", () => {
    expect(retryTarget({ retryStatus: "crawled", error: "x" }, true)).toBe("crawled");
    expect(retryTarget({ retryStatus: null, error: "KI: kaputt" }, true)).toBe("crawled");
    expect(retryTarget({ retryStatus: null, error: "Publish: weg" }, true)).toBe("approved");
    expect(retryTarget({ retryStatus: null, error: "Publish: weg" }, false)).toBe("classified");
    expect(retryTarget({ retryStatus: null, error: "Crawl: HTTP 410" }, true)).toBe("new");
  });

  it("drei Fehlversuche in drei Läufen, dann aussortiert mit letzter Meldung", async () => {
    await prof("K", { feeds: ["https://k.test/rss"] });
    const { ctx } = setup();
    await runPipeline(ctx);
    let [e] = await store.takeByStatus(SITE, ["failed"], 5);
    expect(e).toMatchObject({ attempts: 1, retryStatus: "new" });
    const second = await runPipeline(ctx);
    expect(second.log.find((l) => l.startsWith("Wiederholung:"))).toBe("Wiederholung: 1 Einträge erneut eingereiht, 0 aussortiert.");
    [e] = await store.takeByStatus(SITE, ["failed"], 5);
    expect(e!.attempts).toBe(2);
    await runPipeline(ctx);
    const [r] = await store.takeByStatus(SITE, ["rejected"], 5);
    expect(r).toMatchObject({ attempts: 3, error: "Nach 3 Fehlversuchen aussortiert. Letzter Fehler: Crawl: HTTP 410" });
  });

  it("Altdaten mit drei Versuchen und Status failed werden aussortiert", async () => {
    const id = (await store.insertEntry({ siteId: SITE, profileId: 1, guid: "alt", urlHash: null, feedUrl: "https://x", sourceUrl: "https://x/a", sourceName: "x", titleOriginal: "Alt", publishedAt: null }))!;
    await store.updateEntry(id, { status: "failed", attempts: 3, error: "KI: Zeitüberschreitung" });
    const { ctx } = setup();
    const res = await runPipeline(ctx);
    expect(res.log.find((l) => l.startsWith("Wiederholung:"))).toBe("Wiederholung: 0 Einträge erneut eingereiht, 1 aussortiert.");
    expect((await store.getEntry(id))!.error).toBe("Nach 3 Fehlversuchen aussortiert. Letzter Fehler: KI: Zeitüberschreitung");
  });
});

describe("Zeitbudget der Veröffentlichung", () => {
  it("veröffentlicht nach Ablauf des Budgets nichts mehr in diesem Lauf", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 10 });
    const { ctx, target } = setup({ publishBudgetMs: 30 });
    await runPipeline(ctx);
    const orig = target.target.createPost.bind(target.target);
    target.target.createPost = async (p) => {
      await new Promise((r) => setTimeout(r, 60));
      return orig(p);
    };
    const res = await runPipeline(ctx);
    expect(target.posts).toHaveLength(1);
    expect(res.log.find((l) => /^Veröffentlichung: \d+ von/.test(l))).toBe(
      "Veröffentlichung: 1 von 3 Beiträgen veröffentlicht. Zeitbudget von 0 s erreicht, der Rest folgt im nächsten Lauf.",
    );
  });
});

describe("Profile reihum", () => {
  it("takeFair wechselt zwischen den Profilen und beginnt beim angegebenen", async () => {
    const add = (profileId: number, guid: string) =>
      store.insertEntry({ siteId: SITE, profileId, guid, urlHash: null, feedUrl: "https://f", sourceUrl: "https://s/" + guid, sourceName: "f", titleOriginal: guid, publishedAt: null });
    for (const g of ["a1", "a2", "a3"]) await add(1, g);
    for (const g of ["b1", "b2"]) await add(2, g);
    await add(3, "c1");
    const take = async (order: number[], limit: number) => (await store.takeFair(SITE, ["new"], limit, order)).map((e) => e.guid);
    expect(await take([1, 2], 4)).toEqual(["a1", "b1", "c1", "a2"]);
    expect(await take([2, 1], 3)).toEqual(["b1", "a1", "c1"]);
    expect(await take([2, 1], 10)).toEqual(["b1", "a1", "c1", "b2", "a2", "a3"]);
  });

  it("rotate und wechselnder Start von Lauf zu Lauf", async () => {
    expect(rotate([1, 2, 3], 1)).toEqual([2, 3, 1]);
    expect(rotate([1, 2, 3], 4)).toEqual([2, 3, 1]);
    expect(rotate([], 2)).toEqual([]);
    await store.saveSettings(SITE, { maxPerRun: 1 });
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 10 });
    await prof("B", { feeds: ["https://b.test/rss"], dailyTarget: 10 });
    const { ctx, llm } = setup();
    await runPipeline(ctx);
    await runPipeline(ctx);
    await runPipeline(ctx);
    // je Lauf ein KI-Aufruf, abwechselnd aus beiden Profilen
    const titles = llm.calls.map((c) => /ORIGINALTITEL: (\w)/.exec(c.user)![1]);
    expect(new Set(titles.slice(0, 2))).toEqual(new Set(["A", "B"]));
  });
});

describe("Artikelziel pro Tag", () => {
  it("schreibt je Profil nur bis zum Tagesziel und macht am nächsten Tag weiter", async () => {
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 1 });
    const { ctx, llm } = setup();
    const first = await runPipeline(ctx);
    expect(first.log.find((l) => l.startsWith("KI:"))).toBe("KI: 1 geschrieben, 0 nicht relevant, 0 mit Fehler, 2 warten aufs nächste Tagesziel (von 3).");
    const second = await runPipeline(ctx);
    expect(second.log.find((l) => l.startsWith("KI:"))).toBe("KI: keine Einträge zum Schreiben. 1 Profil hat das Tagesziel erreicht.");
    expect(llm.calls).toHaveLength(1);
    // nächster Tag in Berlin
    clock = new Date("2026-10-16T22:30:00Z");
    const third = await runPipeline(ctx);
    expect(third.log.find((l) => l.startsWith("KI:"))).toMatch(/^KI: 1 geschrieben/);
    expect(llm.calls).toHaveLength(2);
  });

  it("nicht relevante Meldungen zählen nicht zum Ziel", async () => {
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 1 });
    let n = 0;
    const { ctx } = setup({}, () => (n++ === 0 ? '{"relevant": false, "reason": "nein"}' : relevantAnswer()));
    const res = await runPipeline(ctx);
    expect(res.log.find((l) => l.startsWith("KI:"))).toBe("KI: 1 geschrieben, 1 nicht relevant, 0 mit Fehler, 1 warten aufs nächste Tagesziel (von 3).");
  });
});

describe("Tageslimit für KI-Aufrufe", () => {
  it("hält die KI an, ohne Einträge als Fehler zu zählen", async () => {
    await store.saveSettings(SITE, { dailyAiLimit: 2 });
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 10 });
    const { ctx, llm } = setup();
    const res = await runPipeline(ctx);
    expect(res.log.find((l) => l.startsWith("KI:"))).toBe("KI: 2 geschrieben, 0 nicht relevant, 0 mit Fehler (von 3). Tageslimit von 2 KI-Aufrufen erreicht, weiter morgen.");
    expect(llm.calls).toHaveLength(2);
    expect(await store.getUsage(SITE, "2026-10-16", "ai")).toBe(2);
    const [waiting] = await store.takeByStatus(SITE, ["crawled"], 5);
    expect(waiting!.attempts).toBe(0);
  });
  it("0 heißt ohne Limit", async () => {
    await store.saveSettings(SITE, { dailyAiLimit: 0 });
    await prof("A", { feeds: ["https://a.test/rss"], dailyTarget: 10 });
    const { ctx, llm } = setup();
    await runPipeline(ctx);
    expect(llm.calls).toHaveLength(3);
  });
});

describe("Zeitzone und Intervall", () => {
  it("Tagesgrenzen in Berlin, Sommer- und Winterzeit", () => {
    expect(startOfLocalDay(new Date("2026-10-16T10:00:00Z"), "Europe/Berlin").toISOString()).toBe("2026-10-15T22:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-12-01T10:00:00Z"), "Europe/Berlin").toISOString()).toBe("2026-11-30T23:00:00.000Z");
    expect(localDayKey(new Date("2026-10-16T22:30:00Z"), "Europe/Berlin")).toBe("2026-10-17");
    expect(localDayKey(new Date("2026-10-16T22:30:00Z"), "UTC")).toBe("2026-10-16");
    // Tag der Zeitumstellung (25. Oktober 2026): 8 Uhr ist schon Winterzeit
    expect(localTimeOnDay(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin", 8).toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(localTimeOnDay(new Date("2026-10-16T12:00:00Z"), "Europe/Berlin", 24).toISOString()).toBe("2026-10-16T22:00:00.000Z");
  });
  it("ungültige Zeitzone fällt auf Berlin zurück", async () => {
    await store.saveSettings(SITE, { timezone: "Mars/Olympus" });
    expect((await store.getSettings(SITE)).timezone).toBe("Europe/Berlin");
  });
  it("isRunDue mit zwei Minuten Spielraum", () => {
    const last = new Date("2026-10-16T10:02:00Z");
    expect(isRunDue(null, "hourly", last)).toBe(true);
    expect(isRunDue(last, "hourly", new Date("2026-10-16T10:59:00Z"))).toBe(false);
    expect(isRunDue(last, "hourly", new Date("2026-10-16T11:01:00Z"))).toBe(true);
    expect(isRunDue(last, "15min", new Date("2026-10-16T10:17:00Z"))).toBe(true);
  });
  it("CLI: run startet nur, wenn fällig; --force immer; gesperrt ist kein Fehler", async () => {
    await prof("A", { feeds: ["https://a.test/rss"] });
    const { ctx } = setup();
    const lines: string[] = [];
    const build = async () => ({ ctx, close: async () => undefined });
    const out = (l: string) => lines.push(l);
    expect(await runCli(["run"], build, out)).toBe(0);
    expect(lines.at(-1)).toBe("Lauf abgeschlossen.");
    clock = new Date("2026-10-16T10:15:00Z");
    expect(await runCli(["run"], build, out)).toBe(0);
    expect(lines.at(-1)).toBe("Noch nicht fällig (Intervall hourly, letzter Lauf 2026-10-16T10:00:00.000Z).");
    expect(await runCli(["run", "--force"], build, out)).toBe(0);
    expect((await store.listRuns(SITE, 1))[0]!.trigger).toBe("manual");
    const lock = (await store.acquireRunLock(SITE))!;
    expect(await runCli(["run", "--force"], build, out)).toBe(0);
    expect(lines.slice(-2)).toEqual(["Ein anderer Lauf ist noch aktiv, dieser wurde übersprungen.", "Übersprungen."]);
    await lock.release();
  });
});
