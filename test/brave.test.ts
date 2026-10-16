/**
 * Phase 3: Brave-Themensuche und Recherche.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  braveSearch,
  braveSearchUrl,
  braveSlots,
  cleanHeadline,
  formatLocalTime,
  isSimilarHeadline,
  langFromLanguage,
  normalizeKnownHeadlines,
  parseQueryLine,
} from "../src/core/brave";
import type { PipelineContext } from "../src/core/context";
import { runPipeline } from "../src/core/pipeline";
import { braveSelectSystemPrompt, braveSelectUserPrompt } from "../src/core/prompts";
import { parseTopics } from "../src/core/steps/braveDiscover";
import { formatResearch, isSocialHost } from "../src/core/steps/crawl";
import type { LlmRequest } from "../src/core/types";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";
import { articleHtml, braveApi, createFakeHttp, createFakeLlm, createMemoryTarget, relevantAnswer } from "./helpers/fakes";

// ─── Bausteine ─────────────────────────────────────────────────────────────────────────────────

describe("Brave-Bausteine", () => {
  it("Suchzeilen mit Sprachpräfix", () => {
    expect(parseQueryLine("de|Garmin Forerunner")).toEqual({ lang: "de", query: "Garmin Forerunner" });
    expect(parseQueryLine("smartwatch battery")).toEqual({ lang: "en", query: "smartwatch battery" });
    expect(langFromLanguage("Deutsch")).toBe("de");
    expect(langFromLanguage("English")).toBe("en");
    expect(langFromLanguage("Klingonisch")).toBe("en");
  });

  it("Anfrage-URL mit Zeitraum, Sprache, Land und RFC-3986-Leerzeichen", () => {
    const url = braveSearchUrl({ query: "Garmin Forerunner", lang: "de", count: 10, days: 3, now: new Date("2026-10-16T10:00:00Z"), tz: "Europe/Berlin" });
    expect(url).toBe("https://api.search.brave.com/res/v1/news/search?q=Garmin%20Forerunner&count=10&freshness=2026-10-13to2026-10-16&search_lang=de&spellcheck=0&country=DE");
    expect(braveSearchUrl({ query: "x", lang: "en", count: 8, days: 7, now: new Date("2026-10-16T10:00:00Z"), tz: "UTC" })).not.toContain("country");
  });

  it("liest Treffer, entfernt HTML, kürzt Beschreibungen, meldet 429", async () => {
    const api = braveApi({
      a: [{ title: "<b>Neue</b> Uhr", url: "https://n.test/1", description: "x".repeat(400), age: "2 hours ago" }, { title: "ohne URL", url: "" }],
      voll: 429,
      kaputt: 500,
    });
    const { client } = createFakeHttp({}, api.handler);
    const base = { apiKey: "KEY", lang: "en", count: 10, days: 3, now: new Date(), tz: "UTC" };
    const res = await braveSearch(client, { ...base, query: "a" });
    expect(res).toEqual([{ title: "Neue Uhr", url: "https://n.test/1", desc: "x".repeat(300), age: "2 hours ago" }]);
    expect(api.queries[0]!.token).toBe("KEY");
    await expect(braveSearch(client, { ...base, query: "voll" })).rejects.toThrow("Anfragelimit erreicht");
    await expect(braveSearch(client, { ...base, query: "kaputt" })).rejects.toThrow("Brave HTTP 500: Fehler 500");
  });

  it("Zeitplan-Slots gleichmäßig zwischen Start und Ende", () => {
    const at = (iso: string) => braveSlots(new Date(iso), "Europe/Berlin", 3, 8, 22);
    expect(at("2026-10-16T05:00:00Z").due).toBe(0); // 7:00 Uhr
    const noon = at("2026-10-16T10:00:00Z"); // 12:00 Uhr
    expect(noon.due).toBe(1);
    expect(formatLocalTime(noon.next!, "Europe/Berlin")).toBe("12:40");
    expect(at("2026-10-16T15:20:00Z").due).toBe(3); // 17:20 Uhr
    expect(at("2026-10-16T15:20:00Z").next).toBeNull();
  });

  it("Wortvergleich mit Stoppwörtern und Grenzfall 0,5", () => {
    expect(isSimilarHeadline("Garmin Forerunner 970 bekommt neues Update", "Neues Update für Garmin Forerunner 970")).toBe(true);
    // 3 gemeinsame von 6 Wörtern = 0,5 gilt als behandelt, 3 von 7 nicht
    expect(isSimilarHeadline("alpha beta gamma delta", "alpha beta gamma epsilon zeta")).toBe(true);
    expect(isSimilarHeadline("alpha beta gamma delta eta", "alpha beta gamma epsilon zeta")).toBe(false);
    expect(isSimilarHeadline("alpha beta gamma", "alpha beta gamma delta")).toBe(true);
    expect(isSimilarHeadline("Neue Uhr", "Neue Uhr")).toBe(false); // zu wenig Wörter
  });

  it("Überschriften bereinigen und bekannte Überschriften filtern", () => {
    expect(cleanHeadline('1. „Garmin bringt neue Uhr“')).toBe("Garmin bringt neue Uhr");
    expect(cleanHeadline("- **Fitbit stellt App um**")).toBe("Fitbit stellt App um");
    expect(normalizeKnownHeadlines(["zu kurz", "Eine passende Überschrift", "eine passende überschrift", "x".repeat(221)])).toEqual(["Eine passende Überschrift"]);
  });

  it("Themen aus JSON oder zeilenweise", () => {
    expect(parseTopics('{"topics":[{"headline":"Thema eins ist hier","sources":[1,"2",0,-1]}]}')).toEqual([{ headline: "Thema eins ist hier", sources: [1, 2] }]);
    expect(parseTopics('```json\n{"topics": []}\n```')).toEqual([]);
    expect(parseTopics("Hier sind Themen:\nGarmin bringt neues Update für die Fenix\nkurz\n{kaputt")).toEqual([
      { headline: "Hier sind Themen:", sources: [] },
      { headline: "Garmin bringt neues Update für die Fenix", sources: [] },
    ].filter((t) => t.headline.length >= 20));
  });

  it("soziale Netzwerke und Recherche-Format", () => {
    expect(isSocialHost("https://www.youtube.com/watch?v=1")).toBe(true);
    expect(isSocialHost("https://m.facebook.com/x")).toBe(true);
    expect(isSocialHost("https://notreddit.com/x")).toBe(false);
    expect(formatResearch([{ title: "T", url: "https://a.test", desc: "D", text: "X" }, { title: "", url: "https://www.b.test/x", desc: "", text: "Y" }])).toBe(
      "[Quelle 1] T\nURL: https://a.test\nZusammenfassung: D\nAuszug: X\n\n[Quelle 2] b.test\nURL: https://www.b.test/x\nAuszug: Y",
    );
  });
});

describe("Themenauswahl-Prompt entspricht dem Übergabepaket", () => {
  const doc = readFileSync(new URL("../docs/uebergabe/03_Prompts.md", import.meta.url), "utf8");
  const block = (after: string) => /```\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf(after)))![1]!;
  const section = doc.slice(doc.indexOf("## 2. Brave-Themenauswahl"));

  it("System", () => {
    const expected = /### System\n\n```\n([\s\S]*?)```/.exec(section)![1]!.replace("{topic_prompt}", "Profil").replace("{JJJJ-MM-TT}", "2026-10-16");
    expect(braveSelectSystemPrompt("Profil", "2026-10-16") + "\n").toBe(expected);
  });
  it("User", () => {
    const expected = /### User\n\n```\n([\s\S]*?)```/
      .exec(section)![1]!
      .replace("{brave_prompt}", "AUSWAHL")
      .replace("- {Überschrift}\n- …", "- Bekannt eins")
      .replace("{brave_days}", "3")
      .replace("1. {Titel} | {Beschreibung} | {URL} | {Alter, falls vorhanden}\n2. …", "1. T1 | D1 | https://a.test | 2 hours ago\n2. T2 | D2 | https://b.test")
      .replace("{Anzahl}", "2")
      .replace("{language}", "Deutsch");
    const actual = braveSelectUserPrompt({
      bravePrompt: "AUSWAHL",
      known: ["Bekannt eins"],
      results: [
        { title: "T1", desc: "D1", url: "https://a.test", age: "2 hours ago" },
        { title: "T2", desc: "D2", url: "https://b.test" },
      ],
      days: 3,
      count: 2,
      language: "Deutsch",
    });
    expect(actual + "\n").toBe(expected);
    expect(block("### Standard für `brave_prompt`")).toContain("Finde die nützlichsten");
  });
});

// ─── Ganzer Lauf ───────────────────────────────────────────────────────────────────────────────

const SITE = "sft";
let clock: Date;
let store: NewsStore;
beforeEach(async () => {
  clock = new Date("2026-10-16T10:00:00Z"); // 12:00 Uhr in Berlin
  store = await freshStore(() => clock);
});
afterEach(async () => {
  await store.close();
});

const LONG = "Die Quelle beschreibt ausführlich, was das Update für Läufer bringt. ".repeat(10);

function setup(opts: { brave?: Parameters<typeof braveApi>[0]; select?: (req: LlmRequest) => string; key?: string | null; extraRoutes?: Record<string, { status?: number; body: string }> } = {}) {
  const api = braveApi(
    opts.brave ?? {
      "Garmin Forerunner": [
        { title: "Garmin Forerunner erhält Update", url: "https://quelle-a.test/update", description: "Garmin verteilt ein Update." },
        { title: "Update im Test", url: "https://quelle-b.test/test", description: "Erste Eindrücke vom Update." },
        { title: "Video zum Update", url: "https://www.youtube.com/watch?v=1", description: "Video" },
      ],
      "smartwatch battery": [{ title: "Battery tips", url: "https://quelle-c.test/akku", description: "Tips for longer battery life on smartwatches." }],
    },
  );
  const routes = {
    "https://quelle-a.test/update": { body: articleHtml(LONG) },
    "https://quelle-b.test/test": { body: articleHtml(LONG) },
    "https://quelle-c.test/akku": { status: 503, body: "" },
    ...(opts.extraRoutes ?? {}),
  };
  const http = createFakeHttp(routes, api.handler);
  const select =
    opts.select ??
    (() =>
      JSON.stringify({
        topics: [
          { headline: "Kurz", sources: [1] },
          { headline: "Garmin Forerunner: Was das neue Update für Läufer bringt", sources: [1, 2, 3] },
          { headline: "Akku der Smartwatch länger nutzen: Neue Tipps", sources: [4] },
        ],
      }));
  const llm = createFakeLlm((req) => (req.purpose === "brave-select" ? select(req) : relevantAnswer()));
  const target = createMemoryTarget();
  const sleeps: number[] = [];
  const ctx: PipelineContext = {
    siteId: SITE,
    store,
    http: http.client,
    llm: llm.fn,
    target: target.target,
    now: () => clock,
    random: () => 0,
    braveApiKey: opts.key === undefined ? "BRAVE-KEY" : opts.key,
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { ctx, api, llm, target, sleeps, http };
}

const braveProfile = (config: Record<string, unknown> = {}) =>
  store.createProfile(SITE, {
    name: "Neuheiten",
    config: { topicPrompt: "Smartwatches", braveEnabled: true, braveQueries: ["de|Garmin Forerunner", "smartwatch battery"], bravePerDay: 3, dailyTarget: 10, ...config },
  });

describe("Brave-Themensuche im Lauf", () => {
  it("legt das fällige Thema an, recherchiert es und schreibt den Artikel", async () => {
    await braveProfile();
    const { ctx, api, llm, sleeps } = setup();
    const res = await runPipeline(ctx);
    const log = res.log.join("\n");
    expect(log).toContain("Brave (Neuheiten): 1 neue Themen aus 4 Treffern.");
    expect(api.queries.map((q) => [q.q, q.lang, q.country, q.count, q.freshness])).toEqual([
      ["Garmin Forerunner", "de", "DE", "10", "2026-10-13to2026-10-16"],
      ["smartwatch battery", "en", null, "10", "2026-10-13to2026-10-16"],
    ]);
    expect(sleeps).toHaveLength(1);
    expect(await store.getUsage(SITE, "2026-10-16", "brave")).toBe(2);

    const select = llm.calls.find((c) => c.purpose === "brave-select")!;
    expect(select.maxTokens).toBe(2000);
    expect(select.user).toContain("Wähle bis zu 1 Themen.");
    expect(select.user).toContain("3. Video zum Update | Video | https://www.youtube.com/watch?v=1");
    expect(select.system).toContain("Heute ist 2026-10-16.");

    // Recherche im selben Lauf: YouTube fällt raus, beide anderen Quellen gelesen
    expect(log).toContain("Crawl: 0 von 0 Artikeln erfolgreich gecrawlt, Recherche: 1 von 1 Brave-Themen.");
    const [entry] = await store.takeByStatus(SITE, ["classified"], 5);
    expect(entry!.titleOriginal).toBe("Garmin Forerunner: Was das neue Update für Läufer bringt");
    expect(entry!.sourceList).toEqual([
      { title: "Garmin Forerunner erhält Update", url: "https://quelle-a.test/update" },
      { title: "Update im Test", url: "https://quelle-b.test/test" },
    ]);
    expect(entry!.fullContent).toMatch(/^\[Quelle 1\] Garmin Forerunner erhält Update\nURL: https:\/\/quelle-a.test\/update\nZusammenfassung: Garmin verteilt ein Update.\nAuszug: Artikel\n/);
    expect(entry!.fullContent!.length).toBeLessThan(2 * 3800);

    // KI bekommt den Brave-Schreibauftrag und die Quellen
    const classify = llm.calls.find((c) => c.purpose === "classify")!;
    expect(classify.user.startsWith("THEMA: Garmin Forerunner: Was das neue Update für Läufer bringt\n\nQUELLEN:\n[Quelle 1]")).toBe(true);
    expect(classify.system).toContain("Gliederung: Kurzer, packender Einstieg");
    expect(classify.system).toContain("Länge 500 bis 800 Wörter.");
  });

  it("zur selben Zeit kein zweites Thema, Hinweis auf den nächsten Slot", async () => {
    await braveProfile();
    const { ctx, api } = setup();
    await runPipeline(ctx);
    clock = new Date("2026-10-16T10:15:00Z");
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Brave (Neuheiten): Heute 1 von 3 Themen, nächstes ab 12:40 Uhr.");
    expect(api.queries).toHaveLength(2);
  });

  it("überspringt Themen, die schon auf der Seite stehen", async () => {
    await braveProfile();
    const { ctx, target } = setup();
    await target.target.createPost({ title: "Was das neue Update von Garmin Forerunner für Läufer bringt" } as never);
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Brave (Neuheiten): 1 neue Themen aus 4 Treffern, 1 schon behandelt.");
    const [entry] = await store.takeByStatus(SITE, ["new", "crawled", "classified", "failed"], 5);
    expect(entry!.titleOriginal).toBe("Akku der Smartwatch länger nutzen: Neue Tipps");
  });

  it("Thema mit nur einer Quelle: Nachsuche; ohne verwertbare Quellen ein Fehlversuch", async () => {
    await braveProfile();
    const { ctx, api } = setup({
      select: () => JSON.stringify({ topics: [{ headline: "Akku der Smartwatch länger nutzen: Neue Tipps", sources: [4] }] }),
    });
    await runPipeline(ctx);
    const nach = api.queries[2]!;
    expect([nach.q, nach.lang, nach.count, nach.freshness]).toEqual(["Akku der Smartwatch länger nutzen: Neue Tipps", "de", "8", "2026-10-09to2026-10-16"]);
    const [f] = await store.takeByStatus(SITE, ["failed"], 5);
    // Quelle C liefert 503 und hat zu wenig Beschreibung, die Nachsuche bringt nichts
    expect(f).toMatchObject({ retryStatus: "new", error: "Recherche: Keine verwertbaren Quellen gefunden" });
  });

  it("leere Suche: nächster Versuch erst nach einer Stunde", async () => {
    await braveProfile();
    const { ctx, api } = setup({ brave: {} });
    const first = await runPipeline(ctx);
    expect(first.log).toContain("Brave (Neuheiten): keine Treffer.");
    clock = new Date("2026-10-16T10:30:00Z");
    const second = await runPipeline(ctx);
    expect(second.log).toContain("Brave (Neuheiten): letzte Suche ohne neues Thema, nächster Versuch ab 13:00 Uhr.");
    expect(api.queries).toHaveLength(2);
    clock = new Date("2026-10-16T11:01:00Z");
    await runPipeline(ctx);
    expect(api.queries).toHaveLength(4);
  });

  it("429 bei der zweiten Anfrage: Suche endet mit den bisherigen Treffern", async () => {
    await braveProfile();
    const { ctx } = setup({
      brave: { "Garmin Forerunner": [{ title: "A", url: "https://quelle-a.test/update", description: "Garmin verteilt ein Update." }], "smartwatch battery": 429 },
      select: () => JSON.stringify({ topics: [{ headline: "Garmin Forerunner: Was das neue Update für Läufer bringt", sources: [1] }] }),
    });
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Brave (Neuheiten): Anfragelimit erreicht, Suche mit 1 Treffern beendet.");
    expect(res.log).toContain("Brave (Neuheiten): 1 neue Themen aus 1 Treffern.");
  });

  it("Fehler bei der ersten Anfrage beendet die Suche des Profils", async () => {
    await braveProfile();
    const { ctx } = setup({ brave: { "Garmin Forerunner": 401 } });
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Brave (Neuheiten): Suche fehlgeschlagen: Brave HTTP 401: Fehler 401");
    expect(res.status).toBe("completed");
  });

  it("Tageslimit für Brave-Anfragen", async () => {
    await store.saveSettings(SITE, { dailyBraveLimit: 1 });
    await braveProfile();
    const { ctx, api } = setup();
    const res = await runPipeline(ctx);
    expect(api.queries).toHaveLength(1);
    expect(res.log).toContain("Brave (Neuheiten): Tageslimit von 1 Brave-Anfragen erreicht, weiter morgen.");
  });

  it("Pause zwischen Anfragen ist einstellbar", async () => {
    await store.saveSettings(SITE, { braveDelayMs: 0 });
    await braveProfile();
    const { ctx, sleeps } = setup();
    await runPipeline(ctx);
    expect(sleeps).toEqual([]);
  });

  it("ohne Brave-Schlüssel oder ohne eingeschaltete Suche passiert nichts", async () => {
    await braveProfile({ braveEnabled: false });
    expect((await runPipeline(setup().ctx)).log).toContain("Brave: Themensuche ist in keinem aktiven Profil eingeschaltet.");
    await store.updateProfile(SITE, (await store.listProfiles(SITE))[0]!.id, { config: { braveEnabled: true, braveQueries: ["x"] } });
    clock = new Date("2026-10-16T11:30:00Z");
    expect((await runPipeline(setup({ key: null }).ctx)).log).toContain("Brave: kein Brave-Schlüssel hinterlegt (BRAVE_API_KEY).");
  });

  it("„Brave-Themen jetzt suchen“ ignoriert Schalter und Zeitplan", async () => {
    clock = new Date("2026-10-16T04:00:00Z"); // 6 Uhr, noch kein Slot fällig
    await braveProfile({ braveEnabled: false });
    const { ctx, llm } = setup();
    const res = await runPipeline(ctx, { trigger: "manual", braveOnly: true });
    expect(res.log).toEqual(["Brave (Neuheiten): 2 neue Themen aus 4 Treffern.", "Brave: 2 neue Themen (1 Profil durchsucht)."]);
    expect(llm.calls[0]!.user).toContain("Wähle bis zu 3 Themen.");
    expect((await store.getRun(res.runId))!.trigger).toBe("manual");
  });

  it("veröffentlicht Brave-Artikel mit den recherchierten Quellen", async () => {
    await store.saveSettings(SITE, { requireApproval: false });
    await braveProfile();
    const { ctx, target } = setup();
    await runPipeline(ctx);
    clock = new Date("2026-10-16T10:15:00Z");
    await runPipeline(ctx);
    expect(target.posts).toHaveLength(1);
    expect(target.posts[0]).toMatchObject({
      sourceKind: "brave",
      sources: [
        { title: "Garmin Forerunner erhält Update", url: "https://quelle-a.test/update" },
        { title: "Update im Test", url: "https://quelle-b.test/test" },
      ],
    });
  });
});
