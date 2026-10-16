import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";

const SITE = "test-site";
let store: NewsStore;

beforeAll(async () => {
  store = await freshStore();
});
afterAll(async () => {
  await store.close();
});

const entry = (guid: string, extra: Partial<Parameters<NewsStore["insertEntry"]>[0]> = {}) => ({
  siteId: SITE,
  profileId: 1,
  guid,
  urlHash: guid.padEnd(32, "0").slice(0, 32),
  feedUrl: "https://feed.test/rss",
  sourceUrl: "https://quelle.test/" + guid,
  sourceName: "Feed",
  titleOriginal: "Titel " + guid,
  publishedAt: new Date("2026-10-16T08:00:00Z"),
  ...extra,
});

describe("Migrationen", () => {
  it("laufen nur einmal", async () => {
    expect(await store.migrate()).toEqual([]);
  });
});

describe("Einstellungen und Profile", () => {
  it("liefert Standardwerte und speichert bereinigt", async () => {
    expect((await store.getSettings(SITE)).maxPerRun).toBe(5);
    await store.saveSettings(SITE, { maxPerRun: 100, requireApproval: false });
    const s = await store.getSettings(SITE);
    expect(s.maxPerRun).toBe(25);
    expect(s.requireApproval).toBe(false);
    expect((await store.getSettings("andere-seite")).requireApproval).toBe(true);
  });
  it("legt mehrere Profile an und liest nur aktive", async () => {
    const a = await store.createProfile(SITE, { name: "Neuheiten", config: { feeds: "https://a.test/rss" } });
    await store.createProfile(SITE, { name: "Updates", active: false });
    expect(a.config.feeds).toEqual(["https://a.test/rss"]);
    expect((await store.listProfiles(SITE)).map((p) => p.name)).toEqual(["Neuheiten", "Updates"]);
    expect((await store.listProfiles(SITE, { activeOnly: true })).map((p) => p.name)).toEqual(["Neuheiten"]);
    await store.updateProfile(SITE, a.id, { config: { feeds: ["https://b.test/rss"] }, active: false });
    const again = await store.getProfile(SITE, a.id);
    expect(again?.config.feeds).toEqual(["https://b.test/rss"]);
    expect(again?.active).toBe(false);
    await expect(store.createProfile(SITE, { name: "Neuheiten" })).rejects.toThrow();
  });
});

describe("Queue", () => {
  it("legt Einträge an und erkennt doppelte GUIDs je Seite", async () => {
    const id = await store.insertEntry(entry("g1"));
    expect(id).toBeGreaterThan(0);
    expect(await store.insertEntry(entry("g1"))).toBeNull();
    expect(await store.insertEntry(entry("g1", { siteId: "andere-seite" }))).toBeGreaterThan(0);
    expect(await store.guidExists(SITE, "g1")).toBe(true);
    expect(await store.urlHashExists(SITE, "g1".padEnd(32, "0"))).toBe(true);
    expect(await store.urlHashExists(SITE, "x".repeat(32))).toBe(false);
    const e = await store.getEntry(id!);
    expect(e?.status).toBe("new");
    expect(e?.publishedAt?.toISOString()).toBe("2026-10-16T08:00:00.000Z");
  });
  it("liefert die ältesten Einträge eines Status und speichert Änderungen", async () => {
    const id2 = (await store.insertEntry(entry("g2", { profileId: 2 })))!;
    const list = await store.takeByStatus(SITE, ["new"], 10);
    expect(list.map((e) => e.guid)).toEqual(["g1", "g2"]);
    expect((await store.takeByStatus(SITE, ["new"], 10, { profileIds: [2] })).map((e) => e.guid)).toEqual(["g2"]);
    expect(await store.takeByStatus(SITE, ["new"], 10, { profileIds: [] })).toEqual([]);
    await store.updateEntry(id2, { status: "classified", tags: ["A", "B"], relevance: true, sourceList: [{ title: "Q", url: "https://q.test" }] });
    const e = await store.getEntry(id2);
    expect(e?.tags).toEqual(["A", "B"]);
    expect(e?.relevance).toBe(true);
    expect(e?.sourceList).toEqual([{ title: "Q", url: "https://q.test" }]);
  });
  it("Fehler: zweimal failed mit Rücksprung, beim dritten Mal aussortiert", async () => {
    const id = (await store.insertEntry(entry("g3")))!;
    let e = (await store.getEntry(id))!;
    expect(await store.failEntry(e, "new", "Crawl: HTTP 410")).toBe("failed");
    e = (await store.getEntry(id))!;
    expect(e.status).toBe("failed");
    expect(e.retryStatus).toBe("new");
    expect(e.attempts).toBe(1);
    expect(await store.failEntry(e, "new", "Crawl: HTTP 410")).toBe("failed");
    e = (await store.getEntry(id))!;
    expect(await store.failEntry(e, "new", "Crawl: HTTP 504")).toBe("rejected");
    e = (await store.getEntry(id))!;
    expect(e.status).toBe("rejected");
    expect(e.attempts).toBe(3);
    expect(e.error).toBe("Nach 3 Fehlversuchen aussortiert. Letzter Fehler: Crawl: HTTP 504");
  });
  it("kürzt lange Fehlertexte auf 1900 Zeichen", async () => {
    const id = (await store.insertEntry(entry("g4")))!;
    await store.updateEntry(id, { error: "x".repeat(5000) });
    expect((await store.getEntry(id))!.error).toHaveLength(1900);
  });
  it("Sammel-Aktionen: freigeben, aussortieren, erneut versuchen, löschen", async () => {
    const a = (await store.insertEntry(entry("s1")))!;
    const b = (await store.insertEntry(entry("s2")))!;
    const c = (await store.insertEntry(entry("s3")))!;
    await store.updateEntry(a, { status: "classified" });
    await store.updateEntry(b, { status: "classified" });
    await store.updateEntry(c, { status: "failed", attempts: 2, error: "x" });
    expect(await store.approve(SITE, [a, b, c])).toBe(2);
    expect((await store.getEntry(c))!.status).toBe("failed");
    expect(await store.retry(SITE, [c])).toBe(1);
    const rc = (await store.getEntry(c))!;
    expect([rc.status, rc.attempts, rc.error]).toEqual(["new", 0, null]);
    expect(await store.reject(SITE, [a])).toBe(1);
    expect((await store.getEntry(a))!.error).toBe("Von Hand aussortiert");
    expect(await store.remove(SITE, [a, b])).toBe(2);
    expect(await store.getEntry(a)).toBeNull();
    expect(await store.approve(SITE, [])).toBe(0);
    const counts = await store.countByStatus(SITE);
    expect(counts.new).toBeGreaterThan(0);
    expect(counts.published).toBe(0);
  });
});
