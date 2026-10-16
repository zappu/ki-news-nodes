import { describe, expect, it } from "vitest";
import { fetchFeed, parseFeedXml } from "../src/core/feeds";
import { createFakeHttp, rssXml } from "./helpers/fakes";

describe("parseFeedXml", () => {
  it("liest RSS 2.0 mit GUID-Objekt und Datum", () => {
    const feed = parseFeedXml(rssXml("Garmin &amp; Co", [{ title: "Neue Uhr", link: "https://x.test/a", guid: "abc", date: "Fri, 16 Oct 2026 08:00:00 GMT" }, { title: "Ohne", link: "https://x.test/b" }]));
    expect(feed.title).toBe("Garmin & Co");
    expect(feed.items[0]).toEqual({ guid: "abc", link: "https://x.test/a", title: "Neue Uhr", date: new Date("2026-10-16T08:00:00Z") });
    expect(feed.items[1]!.date).toBeNull();
    expect(feed.items[1]!.guid).toBeNull();
  });
  it("liest Atom mit alternate-Link", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>urn:f</id><updated>2026-10-16T08:00:00Z</updated>
      <entry><title type="html">&lt;b&gt;Fett&lt;/b&gt; Titel</title><id>urn:e1</id><link rel="self" href="https://y.test/self"/><link rel="alternate" href="https://y.test/e1"/><updated>2026-10-15T08:00:00Z</updated></entry></feed>`;
    const feed = parseFeedXml(xml);
    expect(feed.title).toBe("Atom");
    expect(feed.items[0]).toMatchObject({ guid: "urn:e1", link: "https://y.test/e1", title: "Fett Titel" });
    expect(feed.items[0]!.date?.toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });
  it("liest RDF mit dc:date", () => {
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="x"><title>RDF</title><link>https://z.test</link><description>d</description></channel><item rdf:about="https://z.test/1"><title>R1</title><link>https://z.test/1</link><dc:date>2026-10-15T10:00:00Z</dc:date></item></rdf:RDF>`;
    expect(parseFeedXml(xml).items[0]).toMatchObject({ link: "https://z.test/1", title: "R1", date: new Date("2026-10-15T10:00:00Z") });
  });
  it("wirft bei Nicht-Feeds", () => {
    expect(() => parseFeedXml("<html><body>Kein Feed</body></html>")).toThrow(/Feed/);
  });
});

describe("fetchFeed", () => {
  it("wirft bei HTTP-Fehlern", async () => {
    const { client } = createFakeHttp({ "https://feed.test/504": { status: 504, body: "" } });
    await expect(fetchFeed(client, "https://feed.test/504")).rejects.toThrow("HTTP 504");
  });
});
