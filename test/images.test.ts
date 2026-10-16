/**
 * Phase 4: Teaserbilder. Die Bilddaten erzeugt sharp im Test, Anbieter und Downloads sind Attrappen.
 */
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PipelineContext } from "../src/core/context";
import type { HttpRequest, HttpResponse } from "../src/core/http";
import { decodeImageDataUrl, finalizeImage, generateTeaserImage, IMAGE_MAX_BYTES, imageModelFor } from "../src/core/images";
import { runPipeline } from "../src/core/pipeline";
import type { NewsStore } from "../src/store/store";
import { freshStore } from "./helpers/db";
import { articleHtml, createFakeHttp, createFakeLlm, createMemoryTarget, relevantAnswer, rssXml, type FakeRoute } from "./helpers/fakes";

let PNG: Buffer;
let JPEG: Buffer;
let WEBP: Buffer;
let GIF: Buffer;

beforeAll(async () => {
  const base = () => sharp({ create: { width: 64, height: 36, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 1 } } });
  PNG = await base().png().toBuffer();
  JPEG = await base().jpeg().toBuffer();
  WEBP = await base().webp().toBuffer();
  GIF = await base().gif().toBuffer();
});

const FAL_URL = "https://fal.run/fal-ai/flux/schnell";
const FAL_IMAGE = "https://v3.fal.media/files/teaser.png";

function falRoutes(image: () => Buffer | number = () => PNG, falStatus = 200): { bodies: { url: string; json: unknown; headers: Record<string, string> }[]; routes: Record<string, FakeRoute> } {
  const bodies: { url: string; json: unknown; headers: Record<string, string> }[] = [];
  return {
    bodies,
    routes: {
      [FAL_URL]: (req: HttpRequest) => {
        bodies.push({ url: req.url, json: req.json, headers: req.headers ?? {} });
        const body = falStatus === 200 ? JSON.stringify({ images: [{ url: FAL_IMAGE, width: 1024, height: 576 }] }) : JSON.stringify({ detail: "Unauthorized" });
        return { status: falStatus, url: req.url, headers: { "content-type": "application/json" }, body: Buffer.from(body) };
      },
      [FAL_IMAGE]: (req: HttpRequest): HttpResponse => {
        const img = image();
        if (typeof img === "number") return { status: img, url: req.url, headers: {}, body: Buffer.from("") };
        return { status: 200, url: req.url, headers: { "content-type": "image/png" }, body: img };
      },
    },
  };
}

describe("Bilddaten prüfen", () => {
  it("Data-URL nur für JPEG, PNG, WebP und sauberes Base64", () => {
    expect(decodeImageDataUrl("data:image/png;base64," + PNG.toString("base64")).equals(PNG)).toBe(true);
    expect(() => decodeImageDataUrl("data:image/gif;base64," + GIF.toString("base64"))).toThrow("ungültige Data-URL");
    expect(() => decodeImageDataUrl("data:image/png;base64,abc$def=")).toThrow("ungültige Data-URL");
    expect(() => decodeImageDataUrl("data:image/png;base64,abcde")).toThrow("ungültige Länge");
    expect(() => decodeImageDataUrl("data:image/png;base64," + "A".repeat(Math.ceil(((IMAGE_MAX_BYTES + 4096) * 4) / 3 / 4) * 4))).toThrow("größer als 8 MiB");
  });

  it("PNG wird zu JPEG, JPEG und WebP bleiben, andere Formate nicht", async () => {
    const fromPng = await finalizeImage(PNG);
    expect(fromPng.mime).toBe("image/jpeg");
    expect(fromPng.ext).toBe("jpg");
    expect(fromPng.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect([fromPng.width, fromPng.height]).toEqual([64, 36]);
    expect((await finalizeImage(JPEG)).buffer).toBe(JPEG);
    expect(await finalizeImage(WEBP)).toMatchObject({ mime: "image/webp", ext: "webp" });
    await expect(finalizeImage(GIF)).rejects.toThrow("Format gif nicht erlaubt");
    await expect(finalizeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"))).rejects.toThrow();
    await expect(finalizeImage(Buffer.alloc(0))).rejects.toThrow("leere Datei");
  });

  it("Modell passend zum Anbieter", () => {
    expect(imageModelFor("fal", "")).toBe("fal-ai/flux/schnell");
    expect(imageModelFor("fal", "fal-ai/recraft-v3")).toBe("fal-ai/recraft-v3");
    expect(imageModelFor("openrouter", "fal-ai/flux/schnell")).toBe("google/gemini-2.5-flash-image");
    expect(imageModelFor("openrouter", "openai/gpt-image-1")).toBe("openai/gpt-image-1");
    expect(imageModelFor("fal", "google/gemini-2.5-flash-image")).toBe("fal-ai/flux/schnell");
  });
});

describe("Anbieter", () => {
  it("fal.ai: Anfrage wie in KNP, Bild wird geladen und umgewandelt", async () => {
    const fal = falRoutes();
    const { client, calls } = createFakeHttp(fal.routes);
    const img = await generateTeaserImage(client, "fal", "fal-ai/flux/schnell", { fal: "FALKEY" }, "Sportuhr am Handgelenk, Morgenlicht");
    expect(img.mime).toBe("image/jpeg");
    expect(fal.bodies[0]).toMatchObject({ json: { prompt: "Sportuhr am Handgelenk, Morgenlicht", image_size: "landscape_16_9", num_images: 1 }, headers: { Authorization: "Key FALKEY" } });
    expect(calls[1]).toMatchObject({ url: FAL_IMAGE, maxBytes: IMAGE_MAX_BYTES, maxRedirects: 3, timeoutMs: 120_000 });
  });

  it("fal.ai: Fehlermeldungen sind lesbar", async () => {
    await expect(generateTeaserImage(createFakeHttp(falRoutes(undefined, 401).routes).client, "fal", "", { fal: "X" }, "b")).rejects.toThrow("fal.ai HTTP 401: Unauthorized");
    await expect(generateTeaserImage(createFakeHttp(falRoutes(() => 404).routes).client, "fal", "", { fal: "X" }, "b")).rejects.toThrow("Bild: Download HTTP 404");
    await expect(generateTeaserImage(createFakeHttp({}).client, "fal", "", {}, "b")).rejects.toThrow("kein fal.ai-Schlüssel hinterlegt (FAL_KEY)");
  });

  it("OpenRouter: Bild als Data-URL in der Antwort", async () => {
    let headers: Record<string, string> = {};
    let json: unknown;
    const { client } = createFakeHttp({
      "https://openrouter.ai/api/v1/chat/completions": (req) => {
        headers = req.headers ?? {};
        json = req.json;
        const body = { choices: [{ message: { content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64," + PNG.toString("base64") } }] } }] };
        return { status: 200, url: req.url, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
      },
    });
    const img = await generateTeaserImage(client, "openrouter", "fal-ai/flux/schnell", { openrouter: "ORKEY", siteUrl: "https://smartwatch-fitnesstracker.de" }, "Briefing");
    expect(img.mime).toBe("image/jpeg");
    expect(headers).toMatchObject({ Authorization: "Bearer ORKEY", "HTTP-Referer": "https://smartwatch-fitnesstracker.de" });
    expect(json).toEqual({ model: "google/gemini-2.5-flash-image", modalities: ["image", "text"], messages: [{ role: "user", content: "Briefing" }] });
  });
});

// ─── Im Lauf ───────────────────────────────────────────────────────────────────────────────────

const SITE = "sft";
const NOW = new Date("2026-10-16T10:00:00Z");
let store: NewsStore;
beforeEach(async () => {
  store = await freshStore(() => NOW);
});
afterEach(async () => {
  await store.close();
});

const LONG = "Die neue Uhr misst den Schlaf genauer und hält länger durch. ".repeat(8);

function setup(fal = falRoutes(), keys: PipelineContext["imageKeys"] = { fal: "FALKEY" }) {
  const routes = {
    "https://garmin.test/rss": {
      body: rssXml("Garmin", [
        { title: "Meldung eins", link: "https://garmin.test/1", guid: "1", date: "Fri, 16 Oct 2026 08:00:00 GMT" },
        { title: "Meldung zwei", link: "https://garmin.test/2", guid: "2", date: "Fri, 16 Oct 2026 08:00:00 GMT" },
      ]),
    },
    "https://garmin.test/1": { body: articleHtml(LONG + "1") },
    "https://garmin.test/2": { body: articleHtml(LONG + "2") },
    ...fal.routes,
  };
  const http = createFakeHttp(routes);
  const target = createMemoryTarget();
  // eigener Titel je Meldung, sonst hält die Idempotenzprüfung beide für denselben Beitrag
  const llm = createFakeLlm((req) => relevantAnswer({ title: "Neue Sportuhr " + /ORIGINALTITEL: Meldung (\w+)/.exec(req.user)![1] }));
  const ctx: PipelineContext = { siteId: SITE, store, http: http.client, llm: llm.fn, target: target.target, now: () => NOW, random: () => 0, imageKeys: keys };
  return { ctx, target, fal, http };
}

async function profile() {
  await store.createProfile(SITE, { name: "A", config: { topicPrompt: "Wearables", feeds: ["https://garmin.test/rss"], dailyTarget: 10 } });
}

describe("Schritt Teaserbilder", () => {
  it("erzeugt Bilder, legt sie über den Adapter ab und hängt sie an den Beitrag", async () => {
    await store.saveSettings(SITE, { imagesEnabled: true, requireApproval: false });
    await profile();
    const { ctx, target, fal } = setup();
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Bilder: 2 erzeugt, 0 fehlgeschlagen (von 2).");
    expect(fal.bodies[0]!.json).toMatchObject({ prompt: "Sportuhr auf Laufstrecke, Morgenlicht" });
    expect(target.images.map((i) => [i.filename, i.mime, i.alt])).toEqual([
      [expect.stringMatching(/^news-teaser-\d+\.jpg$/), "image/jpeg", "Neue Sportuhr eins"],
      [expect.stringMatching(/^news-teaser-\d+\.jpg$/), "image/jpeg", "Neue Sportuhr zwei"],
    ]);
    expect(await store.getUsage(SITE, "2026-10-16", "image")).toBe(2);
    await runPipeline(ctx);
    expect(target.posts.map((p) => [p.imageRef, p.imageAlt])).toEqual([
      ["img-1", "Neue Sportuhr eins"],
      ["img-2", "Neue Sportuhr zwei"],
    ]);
  });

  it("Kandidaten: klassifiziert oder freigegeben, ohne Bild, mit Briefing, ohne endgültigen Bildfehler", async () => {
    const add = async (guid: string, patch: Parameters<NewsStore["updateEntry"]>[1]) => {
      const id = (await store.insertEntry({ siteId: SITE, profileId: 1, guid, urlHash: null, feedUrl: "https://f", sourceUrl: "https://s/" + guid, sourceName: "f", titleOriginal: guid, publishedAt: null }))!;
      await store.updateEntry(id, { imageBriefing: "Szene", ...patch });
      return guid;
    };
    await add("klassifiziert", { status: "classified" });
    await add("freigegeben", { status: "approved" });
    await add("veroeffentlicht", { status: "published" });
    await add("hat-bild", { status: "classified", imageRef: "img-9" });
    await add("ohne-briefing", { status: "classified", imageBriefing: "" });
    await add("ein-fehler", { status: "classified", error: "Bild: fal.ai HTTP 500" });
    await add("zwei-fehler", { status: "classified", error: "Bild (2. Versuch): fal.ai HTTP 500" });
    const take = async (statuses: ("classified" | "approved")[]) => (await store.takeImageCandidates(SITE, statuses, 10, "Bild (2. Versuch):")).map((e) => e.guid);
    expect(await take(["classified", "approved"])).toEqual(["klassifiziert", "freigegeben", "ein-fehler"]);
    expect(await take(["classified"])).toEqual(["klassifiziert", "ein-fehler"]);
  });

  it("Bildfehler blockieren nichts und werden höchstens zweimal versucht", async () => {
    await store.saveSettings(SITE, { imagesEnabled: true, requireApproval: true, maxPerRun: 1 });
    await profile();
    const fal = falRoutes(undefined, 500);
    const { ctx, http } = setup(fal);
    await runPipeline(ctx);
    let [e] = await store.takeByStatus(SITE, ["classified"], 1);
    expect(e).toMatchObject({ status: "classified", attempts: 0, imageRef: null });
    expect(e!.error).toMatch(/^Bild: fal\.ai HTTP 500/);
    await runPipeline(ctx);
    e = (await store.getEntry(e!.id))!;
    expect(e.error).toMatch(/^Bild \(2\. Versuch\): fal\.ai HTTP 500/);
    // der erste ist fertig, der zweite bekommt in den nächsten zwei Läufen seine zwei Versuche, danach nichts mehr
    const falCalls = () => http.calls.filter((c) => c.url === FAL_URL).length;
    const before = falCalls();
    await runPipeline(ctx);
    await runPipeline(ctx);
    expect(falCalls() - before).toBe(2);
    await runPipeline(ctx);
    expect(falCalls() - before).toBe(2);
    // Freigabe und Veröffentlichung gehen trotzdem
    await store.approve(SITE, [e.id]);
    await runPipeline(ctx);
    expect((await store.getEntry(e.id))!.status).toBe("published");
  });

  it("Tageslimit für Bilder", async () => {
    await store.saveSettings(SITE, { imagesEnabled: true, dailyImageLimit: 1 });
    await profile();
    const { ctx, target } = setup();
    const res = await runPipeline(ctx);
    expect(res.log).toContain("Bilder: 1 erzeugt, 0 fehlgeschlagen (von 2). Tageslimit von 1 Bildern erreicht, weiter morgen.");
    expect(target.images).toHaveLength(1);
  });

  it("ausgeschaltet oder ohne Schlüssel passiert nichts", async () => {
    await profile();
    expect((await runPipeline(setup().ctx)).log).toContain("Bilder: ausgeschaltet.");
    await store.saveSettings(SITE, { imagesEnabled: true });
    const { ctx, fal } = setup(falRoutes(), {});
    expect((await runPipeline(ctx)).log).toContain("Bilder: 2 Einträge warten, aber es ist kein fal.ai-Schlüssel (FAL_KEY) hinterlegt.");
    expect(fal.bodies).toHaveLength(0);
  });

  it("Ablage beim Adapter scheitert: als Bildfehler notiert", async () => {
    await store.saveSettings(SITE, { imagesEnabled: true, maxPerRun: 1 });
    await profile();
    const { ctx, target } = setup();
    target.state.failUpload = "Speicher voll";
    await runPipeline(ctx);
    const [e] = await store.takeByStatus(SITE, ["classified"], 1);
    expect(e!.error).toBe("Bild: Speicher voll");
  });
});
