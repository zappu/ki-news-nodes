/**
 * Phase 5 im Paket: tägliche Wartung (Ablauf, Hinweis-Mail) und Admin-Dienst.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNewsAdmin, type NewsClient } from "../src/admin/service";
import { NewsAdmin } from "../src/admin/ui/NewsAdmin";
import type { PipelineContext } from "../src/core/context";
import { runPipeline } from "../src/core/pipeline";
import { waitingMail } from "../src/core/steps/maintenance";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";
import { articleHtml, createFakeHttp, createFakeLlm, createMemoryTarget, relevantAnswer, rssXml } from "./helpers/fakes";

const SITE = "sft";
let clock: Date;
let store: NewsStore;
beforeEach(async () => {
  clock = new Date("2026-10-16T05:00:00Z"); // 7 Uhr in Berlin
  store = await freshStore(() => clock);
});
afterEach(async () => {
  await store.close();
});

const LONG = "Die neue Uhr misst den Puls genauer und hält länger durch. ".repeat(8);

function setup(extra: Partial<PipelineContext> = {}) {
  const http = createFakeHttp({
    "https://garmin.test/rss": {
      body: rssXml("Garmin", [
        { title: "Meldung eins", link: "https://garmin.test/1", guid: "1", date: "Fri, 16 Oct 2026 04:00:00 GMT" },
        { title: "Meldung zwei", link: "https://garmin.test/2", guid: "2", date: "Fri, 16 Oct 2026 04:00:00 GMT" },
      ]),
    },
    "https://garmin.test/1": { body: articleHtml(LONG + "1") },
    "https://garmin.test/2": { body: articleHtml(LONG + "2") },
  });
  const mails: { subject: string; text: string; html: string }[] = [];
  const target = createMemoryTarget();
  const llm = createFakeLlm((req) => relevantAnswer({ title: "Uhr " + /ORIGINALTITEL: Meldung (\w+)/.exec(req.user)![1] }));
  const ctx: PipelineContext = {
    siteId: SITE,
    store,
    http: http.client,
    llm: llm.fn,
    target: target.target,
    now: () => clock,
    random: () => 0,
    notify: async (m) => void mails.push(m),
    adminUrl: "https://seite.test/admin/news",
    ...extra,
  };
  return { ctx, mails, target };
}

describe("Tägliche Wartung", () => {
  it("vor 8 Uhr nichts, danach einmal am Tag Mail zu wartenden Artikeln", async () => {
    const prof = await store.createProfile(SITE, { name: "Neuheiten", config: { feeds: ["https://garmin.test/rss"], dailyTarget: 10 } });
    const { ctx, mails } = setup();
    const first = await runPipeline(ctx);
    expect(first.log[0]).toBe("Wartung: heute ab 8 Uhr.");
    expect(mails).toHaveLength(0);
    clock = new Date("2026-10-16T06:05:00Z"); // 8:05 Uhr
    const second = await runPipeline(ctx);
    expect(second.log[0]).toBe("Wartung: 0 nicht freigegebene und 0 liegengebliebene Einträge abgelaufen, Hinweis-Mail zu 2 wartenden Artikeln gesendet.");
    expect(mails[0]!.subject).toBe("2 News-Artikel warten auf Freigabe");
    expect(mails[0]!.text).toContain("Neuheiten: 2");
    expect(mails[0]!.html).toContain('<a href="https://seite.test/admin/news">Zur Queue</a>');
    clock = new Date("2026-10-16T09:00:00Z");
    expect((await runPipeline(ctx)).log[0]).toBe("Wartung: heute schon erledigt.");
    expect(mails).toHaveLength(1);
    expect(prof.id).toBeGreaterThan(0);
  });

  it("lässt nicht freigegebene und liegengebliebene Einträge nach der Frist ablaufen", async () => {
    await store.createProfile(SITE, { name: "A", config: { feeds: ["https://garmin.test/rss"], dailyTarget: 1 } });
    const { ctx, mails } = setup();
    await runPipeline(ctx); // eins geschrieben, eins wartet auf crawled
    clock = new Date("2026-10-31T07:00:00Z"); // 15 Tage später, 8 Uhr Winterzeit
    const res = await runPipeline({ ...ctx, notify: undefined });
    expect(res.log[0]).toBe("Wartung: 1 nicht freigegebene und 1 liegengebliebene Einträge abgelaufen, keine Hinweis-Mail.");
    const rejected = await store.takeByStatus(SITE, ["rejected"], 5);
    expect(rejected.map((e) => e.error).sort()).toEqual([
      "Abgelaufen: nicht innerhalb von 14 Tagen freigegeben",
      "Abgelaufen: nicht innerhalb von 14 Tagen verarbeitet. Letzte Meldung: -",
    ]);
    expect(mails).toHaveLength(0);
  });

  it("ohne Mailversand steht es im Protokoll", async () => {
    await store.createProfile(SITE, { name: "A", config: { feeds: ["https://garmin.test/rss"], dailyTarget: 10 } });
    const { ctx } = setup({ notify: undefined });
    await runPipeline(ctx);
    clock = new Date("2026-10-16T06:05:00Z");
    expect((await runPipeline(ctx)).log[0]).toMatch(/2 Artikel warten, aber es ist kein Mailversand eingerichtet\.$/);
  });

  it("Mailtext in Einzahl und mit maskiertem HTML", () => {
    const m = waitingMail([{ profile: "<A&B>", count: 1 }], 1, null);
    expect(m.subject).toBe("1 News-Artikel wartet auf Freigabe");
    expect(m.html).toContain("<li>&lt;A&amp;B&gt;: 1</li>");
    expect(m.text).not.toContain("Zur Queue");
  });
});

describe("Admin-Dienst", () => {
  function admin(extra: Partial<PipelineContext> = {}) {
    const { ctx } = setup(extra);
    const started: { braveOnly: boolean }[] = [];
    const a = createNewsAdmin({
      siteId: SITE,
      store,
      buildContext: () => ctx,
      keys: { llm: true, brave: false, fal: false, openrouter: false, mail: true },
      startRun: (_c, o) => void started.push(o),
    });
    return { a, ctx, started };
  }

  it("Übersicht, Queue mit Filtern und Detail", async () => {
    const p = await store.createProfile(SITE, { name: "Neuheiten", config: { feeds: ["https://garmin.test/rss"], dailyTarget: 10 } });
    const { a, ctx } = admin();
    await runPipeline(ctx);
    const ov = await a.overview({});
    expect(ov).toMatchObject({ waiting: 2, profiles: { total: 1, active: 1 }, running: false, usageToday: { ai: 2, brave: 0, image: 0 }, limits: { ai: 60 }, keys: { brave: false } });
    expect(ov.lastRun?.status).toBe("completed");
    expect(ov.version).toMatch(/^\d+\.\d+\.\d+$/);

    const q = await a.queue({ status: "classified", profileId: p.id });
    expect(q.total).toBe(2);
    expect(q.counts.classified).toBe(2);
    expect(q.items[0]).toMatchObject({ kind: "rss", status: "classified", sourceName: "Garmin" });
    expect(q.items[0]).not.toHaveProperty("rewrittenContent");
    expect((await a.queue({ search: "eins" })).items.map((i) => i.rewrittenTitle)).toEqual(["Uhr eins"]);
    expect((await a.queue({ search: "100%_" })).total).toBe(0);
    expect((await a.queue({ pageSize: 1, page: 2 })).items).toHaveLength(1);

    const d = (await a.entry({ id: q.items[0]!.id }))!;
    expect(d.contentHtml).toContain("<h2>Was ist neu</h2>");
    expect(d.fullContentChars).toBeGreaterThan(300);
    expect(await a.entry({ id: 99999 })).toBeNull();
  });

  it("Sammel-Aktionen", async () => {
    await store.createProfile(SITE, { name: "A", config: { feeds: ["https://garmin.test/rss"], dailyTarget: 10 } });
    const { a, ctx } = admin();
    await runPipeline(ctx);
    const ids = (await a.queue({ status: "classified" })).items.map((i) => i.id);
    expect(await a.bulk({ action: "approve", ids })).toEqual({ changed: 2 });
    expect(await a.bulk({ action: "reject", ids: [ids[0]!] })).toEqual({ changed: 1 });
    expect(await a.bulk({ action: "retry", ids: [ids[0]!] })).toEqual({ changed: 1 });
    expect(await a.bulk({ action: "delete", ids })).toEqual({ changed: 2 });
    await expect(a.bulk({ action: "approve", ids: [] })).rejects.toThrow();
  });

  it("Einstellungen werden ergänzt und bereinigt gespeichert", async () => {
    const { a } = admin();
    const s = await a.saveSettings({ settings: { maxPerRun: 99, requireApproval: false } });
    expect(s.maxPerRun).toBe(25);
    expect(s.requireApproval).toBe(false);
    const again = await a.saveSettings({ settings: { maxTags: 4 } });
    expect([again.requireApproval, again.maxTags]).toEqual([false, 4]);
    expect((await a.settings({})).maxTags).toBe(4);
  });

  it("Profile anlegen, ändern, doppelte Namen ablehnen, löschen", async () => {
    const { a } = admin();
    const p = await a.saveProfile({ name: "Neuheiten", active: true, config: { feeds: ["https://a.test/rss"], dailyTarget: 2 } });
    expect(p.config.dailyTarget).toBe(2);
    const changed = await a.saveProfile({ id: p.id, name: "Neuheiten", active: false, config: { ...p.config, bravePerDay: 5 } });
    expect([changed.active, changed.config.bravePerDay]).toEqual([false, 5]);
    await a.saveProfile({ name: "Updates", active: true, config: {} });
    await expect(a.saveProfile({ name: "neuheiten", active: true, config: {} })).rejects.toThrow("Es gibt schon ein Profil „neuheiten“.");
    await expect(a.saveProfile({ id: 9999, name: "X", active: true, config: {} })).rejects.toThrow("Profil nicht gefunden.");
    expect(await a.deleteProfile({ id: p.id })).toEqual({ deleted: true });
    expect((await a.profiles({})).map((x) => x.name)).toEqual(["Updates"]);
  });

  it("Kategorien, Läufe, Start und Feed-Test", async () => {
    const { a, ctx, started } = admin();
    expect((await a.categories({})).map((c) => c.name)).toEqual(["Smartwatches", "Sportuhren", "News"]);
    const res = await runPipeline(ctx);
    const runs = await a.runs({});
    expect(runs[0]).toMatchObject({ id: res.runId, status: "completed", lines: res.log.length });
    expect((await a.run({ id: res.runId }))!.log).toEqual(res.log);
    expect(await a.start({ braveOnly: true })).toEqual({ started: true });
    expect(started).toEqual([{ braveOnly: true }]);
    const ok = await a.testFeed({ url: "https://garmin.test/rss" });
    expect(ok).toMatchObject({ ok: true, title: "Garmin", error: null });
    expect(ok.items).toHaveLength(2);
    expect(await a.testFeed({ url: "ftp://x" })).toMatchObject({ ok: false, error: "Keine gültige http(s)-Adresse." });
    expect(await a.testFeed({ url: "https://garmin.test/fehlt" })).toMatchObject({ ok: false, error: "HTTP 404" });
  });
});

describe("React-Seiten", () => {
  it("laden nur Typen aus dem Server-Teil", () => {
    const src = readFileSync(new URL("../src/admin/ui/NewsAdmin.tsx", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)];
    for (const [, isType, from] of imports) {
      if (from === "react") continue;
      expect(isType, `Import aus ${from} muss „import type“ sein`).toBeTruthy();
    }
  });

  it("lassen sich rendern", () => {
    const never = () => new Promise<never>(() => undefined);
    const client = new Proxy({}, { get: () => ({ query: never, mutate: never }) }) as unknown as NewsClient;
    const html = renderToStaticMarkup(createElement(NewsAdmin, { client, homeHref: "/admin" }));
    expect(html).toContain("Lauf jetzt starten");
    expect(html).toContain('href="/admin"');
    expect(html).toContain(">Queue<");
  });
});
