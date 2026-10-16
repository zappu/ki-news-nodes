/**
 * Ganzer Lauf gegen die Testdatenbank, mit Attrappen für Feeds, Quellseiten, KI und Zielseite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import type { PipelineContext } from "../src/core/context";
import { runPipeline } from "../src/core/pipeline";
import { buildClassifyRequest, categoriesForProfile, parseClassifyResponse } from "../src/core/steps/classify";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";
import { articleHtml, createFakeHttp, createFakeLlm, createMemoryTarget, relevantAnswer, rssXml, SITE_CATEGORIES } from "./helpers/fakes";

const SITE = "sft";
const NOW = new Date("2026-10-16T12:00:00Z");
const LONG = "Die neue Uhr bringt mehr Akkulaufzeit und ein helleres Display. ".repeat(8);

let store: NewsStore;
beforeEach(async () => {
  store = await freshStore(() => NOW);
});
afterEach(async () => {
  await store.close();
});

function setup(opts: { llm?: ReturnType<typeof createFakeLlm> | null } = {}) {
  const http = createFakeHttp({
    "https://garmin.test/rss": {
      body: rssXml("Garmin Newsroom", [
        { title: "Neue Sportuhr", link: "https://garmin.test/news/uhr?utm_source=rss", guid: "g-1", date: "Fri, 16 Oct 2026 08:00:00 GMT" },
        { title: "Alte Meldung", link: "https://garmin.test/news/alt", guid: "g-2", date: "Mon, 12 Oct 2026 08:00:00 GMT" },
        { title: "Ohne Datum", link: "https://garmin.test/news/ohne", guid: "g-3" },
      ]),
      headers: { "content-type": "application/rss+xml" },
    },
    // gleiche Meldung in einem zweiten Feed, andere GUID, Link mit anderem Tracking
    "https://zweit.test/rss": { body: rssXml("Zweitfeed", [{ title: "Neue Sportuhr", link: "https://garmin.test/news/uhr/?fbclid=1", guid: "z-1", date: "Fri, 16 Oct 2026 09:00:00 GMT" }]) },
    "https://kaputt.test/rss": { status: 504, body: "" },
    "https://garmin.test/news/uhr?utm_source=rss": { body: articleHtml(LONG) },
    "https://garmin.test/news/ohne": { status: 410, body: "weg" },
  });
  const llm = opts.llm === undefined ? createFakeLlm(() => relevantAnswer()) : opts.llm;
  const target = createMemoryTarget();
  const ctx: PipelineContext = { siteId: SITE, store, http: http.client, llm: llm?.fn ?? null, target: target.target, now: () => NOW, random: () => 0 };
  return { ctx, http, llm, target };
}

async function profile(config: Record<string, unknown> = {}, name = "Neuheiten") {
  return store.createProfile(SITE, { name, config: { topicPrompt: "Smartwatches und Sportuhren", feeds: ["https://garmin.test/rss", "https://zweit.test/rss", "https://kaputt.test/rss"], ...config } });
}

describe("Lauf ohne manuelle Freigabe", () => {
  it("importiert, crawlt, schreibt und veröffentlicht im nächsten Lauf", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await profile();
    const { ctx, llm, target } = setup();

    const first = await runPipeline(ctx);
    expect(first.status).toBe("completed");
    const log = first.log.join("\n");
    expect(log).toContain("RSS-Import: 2 neue Einträge aus 3 Feeds, 1 Feeds mit Fehler (1 schon bekannt, 1 zu alt).");
    expect(log).toContain("Feed https://kaputt.test/rss fehlgeschlagen: HTTP 504");
    expect(log).toContain("Crawl: 1 von 2 Artikeln erfolgreich gecrawlt.");
    expect(log).toContain("KI: 1 geschrieben, 0 nicht relevant, 0 mit Fehler (von 1).");
    // Veröffentlichung läuft vor der KI, deshalb erst im nächsten Lauf
    expect(target.posts).toHaveLength(0);

    const [entry] = await store.takeByStatus(SITE, ["classified"], 5);
    expect(entry!.rewrittenTitle).toBe("Neue Sportuhr, mehr Akku");
    expect(entry!.rewrittenContent).toBe("<h2>Was ist neu</h2><p>Die Uhr hält länger durch, bis zu zwei Wochen.</p>");
    expect(entry!.tags).toEqual(["Sportuhr", "Akku", "GPS"]);
    expect(llm!.calls[0]!.purpose).toBe("classify");
    expect(llm!.calls[0]!.timeoutMs).toBe(180_000);
    expect(llm!.calls[0]!.user).toContain("ORIGINALTITEL: Neue Sportuhr");
    expect(llm!.calls[0]!.system).toContain("sportuhren = Sportuhren");

    const failed = await store.takeByStatus(SITE, ["failed"], 5);
    expect(failed[0]).toMatchObject({ retryStatus: "new", attempts: 1, error: "Crawl: HTTP 410" });

    const second = await runPipeline(ctx);
    expect(second.log.join("\n")).toContain("Veröffentlichung: 1 von 1 Beiträgen veröffentlicht.");
    expect(target.posts).toHaveLength(1);
    const post = target.posts[0]!;
    expect(post).toMatchObject({
      title: "Neue Sportuhr, mehr Akku",
      slugBase: "neue-sportuhr-mehr-akku",
      status: "published",
      category: "Sportuhren",
      tags: ["Sportuhr", "Akku", "GPS"],
      sourceKind: "rss",
      sources: [{ title: "Garmin Newsroom", url: "https://garmin.test/news/uhr?utm_source=rss" }],
      aiDisclosure: "Dieser Beitrag wurde mit Unterstützung von KI erstellt und redaktionell geprüft.",
    });
    const published = await store.getEntry(entry!.id);
    expect(published).toMatchObject({ status: "published", postRef: post.ref });
  });
});

describe("Lauf mit manueller Freigabe", () => {
  it("wartet auf die Freigabe und veröffentlicht danach", async () => {
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx, target } = setup();
    await runPipeline(ctx);
    await runPipeline(ctx);
    expect(target.posts).toHaveLength(0);
    const [entry] = await store.takeByStatus(SITE, ["classified"], 5);
    expect(await store.approve(SITE, [entry!.id])).toBe(1);
    await runPipeline(ctx);
    expect(target.posts).toHaveLength(1);
  });
});

describe("KI", () => {
  it("sortiert nicht relevante Meldungen mit Grund aus", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx } = setup({ llm: createFakeLlm(() => '{"relevant": false, "reason": "Kein Bezug zu Wearables"}') });
    await runPipeline(ctx);
    const [rej] = await store.takeByStatus(SITE, ["rejected"], 5);
    expect(rej).toMatchObject({ relevance: false, error: "Kein Bezug zu Wearables" });
  });
  it("kaputtes JSON zählt als Fehlversuch mit Rücksprung auf crawled", async () => {
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx } = setup({ llm: createFakeLlm(() => "Tut mir leid, das kann ich nicht.") });
    await runPipeline(ctx);
    const [f] = (await store.takeByStatus(SITE, ["failed"], 5)).filter((e) => e.retryStatus === "crawled");
    expect(f!.error).toMatch(/^KI: Antwort ist kein gültiges JSON: Tut mir leid/);
  });
  it("ohne KI-Schlüssel bleibt alles auf crawled", async () => {
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx } = setup({ llm: null });
    const res = await runPipeline(ctx);
    expect(res.log.join("\n")).toContain("KI: 1 Einträge warten, aber es ist kein KI-Schlüssel hinterlegt.");
    expect(await store.takeByStatus(SITE, ["crawled"], 5)).toHaveLength(1);
  });
  it("feste Kategorie im Profil: nur sie steht im Prompt und am Beitrag", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await profile({ feeds: ["https://garmin.test/rss"], fixedCategory: "News" });
    const { ctx, llm, target } = setup();
    await runPipeline(ctx);
    await runPipeline(ctx);
    expect(llm!.calls[0]!.system).toContain("VERFÜGBARE KATEGORIEN (nur diese Keys verwenden):\nnews = News\n\nAUFGABE");
    expect(target.posts[0]!.category).toBe("News");
  });
  it("unbekannte Kategorie geht nach News", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx, target } = setup({ llm: createFakeLlm(() => relevantAnswer({ category_key: "gibtsnicht" })) });
    await runPipeline(ctx);
    await runPipeline(ctx);
    expect(target.posts[0]!.category).toBe("News");
  });
  it("Länge und Token-Limit kommen aus der gezogenen Stufe", async () => {
    const p = await profile({ rssLengths: ["long"] });
    const entry = { feedUrl: "https://x", sourceUrl: "https://x/a", titleOriginal: "T", fullContent: "Text" } as never;
    const req = buildClassifyRequest(entry, p, categoriesForProfile(p, SITE_CATEGORIES), { settings: await store.getSettings(SITE), random: () => 0 });
    expect(req.system).toContain("Länge 800 bis 1200 Wörter.");
    expect(req.maxTokens).toBe(6800);
  });
  it("Antwort ohne Text ist ein Fehler", () => {
    expect(() => parseClassifyResponse(relevantAnswer({ content_html: "<p> </p>" }), { tagsEnabled: true, maxTags: 6 })).toThrow("Antwort ohne Titel oder Text");
  });
});

describe("Veröffentlichung", () => {
  it("legt nach einem Abbruch keinen zweiten Beitrag an", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx, target } = setup();
    await runPipeline(ctx);
    target.state.failNextCreateAfterSave = true;
    await runPipeline(ctx);
    expect(target.posts).toHaveLength(1);
    const [f] = await store.takeByStatus(SITE, ["failed"], 5);
    expect(f).toMatchObject({ retryStatus: "classified", error: "Publish: Beitrag anlegen: Verbindung abgebrochen" });
    // Die Wiederholung am Anfang des nächsten Laufs setzt den Eintrag zurück auf „classified“
    await runPipeline(ctx);
    expect(target.posts).toHaveLength(1);
    expect(target.posts[0]!.completed).toBe(1);
    expect((await store.getEntry(f!.id))!.status).toBe("published");
  });
  it("ohne Quellenangabe und KI-Hinweis", async () => {
    await store.saveSettings(SITE, { requireApproval: false, addSourceLink: false, aiDisclosure: "", tagsEnabled: false, postStatus: "draft" });
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx, target, llm } = setup();
    await runPipeline(ctx);
    await runPipeline(ctx);
    expect(llm!.calls[0]!.system).not.toContain("Schlagworte");
    expect(target.posts[0]).toMatchObject({ sources: [], aiDisclosure: "", tags: [], status: "draft" });
  });
});

describe("Profile", () => {
  it("inaktive Profile importieren nichts, Duplikate gelten über alle Profile", async () => {
    await profile({ feeds: ["https://garmin.test/rss"] }, "A");
    const b = await profile({ feeds: ["https://zweit.test/rss"] }, "B");
    const off = await profile({ feeds: ["https://garmin.test/rss"] }, "Aus");
    await store.updateProfile(SITE, off.id, { active: false });
    const { ctx } = setup();
    const res = await runPipeline(ctx);
    expect(res.log.join("\n")).toContain("RSS-Import: 2 neue Einträge aus 2 Feeds (1 schon bekannt, 1 zu alt).");
    const all = await store.takeByStatus(SITE, ["new", "crawled", "classified", "failed"], 10);
    expect(all.every((e) => e.profileId !== b.id && e.profileId !== off.id)).toBe(true);
  });
  it("ohne aktives Profil gibt es einen Hinweis", async () => {
    const { ctx } = setup();
    const res = await runPipeline(ctx);
    expect(res.log[0]).toBe("Hinweis: kein aktives Profil, es werden keine neuen Meldungen gesucht.");
  });
});

describe("CLI", () => {
  it("run, status und unbekannte Befehle", async () => {
    await profile({ feeds: ["https://garmin.test/rss"] });
    const { ctx } = setup();
    const lines: string[] = [];
    let closed = 0;
    const build = async () => ({ ctx, close: async () => void closed++ });
    expect(await runCli(["run"], build, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("Lauf abgeschlossen.");
    expect(await runCli(["status"], build, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-2)).toMatch(/^new: \d+, crawled: \d+, classified: 1,/);
    expect(lines.at(-1)).toMatch(/^Letzter Lauf: .* completed: Lauf abgeschlossen\.$/);
    expect(await runCli(["quatsch"], build, (l) => lines.push(l))).toBe(2);
    expect(await runCli(["run"], async () => { throw new Error("keine Datenbank"); }, (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toBe("Fehler: keine Datenbank");
    expect(closed).toBe(2);
  });
});
