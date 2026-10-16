/**
 * Attrappen für Tests: HTTP-Client, KI-Funktion und Ziel-Adapter. Kein Test darf ins Netz.
 */
import type { HttpClient, HttpRequest, HttpResponse } from "../../src/core/http";
import type { Category, LlmFn, LlmRequest, PostPayload, PublishTarget } from "../../src/core/types";

type FakeRoute = { status?: number; body: string; headers?: Record<string, string> } | ((req: HttpRequest) => HttpResponse | Promise<HttpResponse>);

export function createFakeHttp(routes: Record<string, FakeRoute>) {
  const calls: HttpRequest[] = [];
  const client: HttpClient = {
    async request(req) {
      calls.push(req);
      const route = routes[req.url];
      if (!route) return { status: 404, url: req.url, headers: {}, body: Buffer.from("nicht gefunden") };
      if (typeof route === "function") return route(req);
      return { status: route.status ?? 200, url: req.url, headers: route.headers ?? { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(route.body, "utf8") };
    },
  };
  return { client, calls, routes };
}

/** KI-Attrappe: Antwort je Aufruf aus einer Funktion; merkt sich alle Anfragen */
export function createFakeLlm(answer: (req: LlmRequest) => string | Promise<string>) {
  const calls: LlmRequest[] = [];
  const fn: LlmFn = async (req) => {
    calls.push(req);
    return answer(req);
  };
  return { fn, calls };
}

export function relevantAnswer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    relevant: true,
    title: "Neue Sportuhr – mehr Akku",
    content_html: "<h2>Was ist neu</h2><p>Die Uhr hält länger durch — bis zu zwei Wochen.</p><script>x()</script>",
    teaser: "Mehr Akku für Läufer",
    seo_title: "Neue Sportuhr mit mehr Akku",
    seo_description: "Was die neue Sportuhr kann.",
    category_key: "sportuhren",
    image_briefing: "Sportuhr auf Laufstrecke, Morgenlicht",
    tags: ["#Sportuhr", "Akku", "akku", "GPS"],
    ...over,
  });
}

export const SITE_CATEGORIES: Category[] = [
  { key: "smartwatches", name: "Smartwatches" },
  { key: "sportuhren", name: "Sportuhren" },
  { key: "news", name: "News" },
];

export interface StoredPost extends PostPayload {
  ref: string;
  completed: number;
}

/** Ziel-Adapter im Speicher; `failNextCreate` simuliert einen Abbruch nach dem Anlegen */
export function createMemoryTarget(categories: Category[] = SITE_CATEGORIES) {
  const posts: StoredPost[] = [];
  const state = { failNextCreateAfterSave: false, failCreate: null as string | null };
  const target: PublishTarget = {
    async categories() {
      return categories;
    },
    async recentTitles(limit) {
      return posts.slice(-limit).map((p) => p.title);
    },
    async findExisting({ queueId, title, fingerprint }) {
      const byId = posts.find((p) => p.origin.queueId === queueId);
      if (byId) return byId.ref;
      const byText = posts.find((p) => p.title === title && p.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) === fingerprint);
      return byText?.ref ?? null;
    },
    async createPost(post) {
      if (state.failCreate) throw new Error(state.failCreate);
      const ref = String(posts.length + 1);
      posts.push({ ...post, ref, completed: 0 });
      if (state.failNextCreateAfterSave) {
        state.failNextCreateAfterSave = false;
        throw new Error("Verbindung abgebrochen");
      }
      return { ref };
    },
    async completePost(ref, post) {
      const p = posts.find((x) => x.ref === ref);
      if (!p) throw new Error("Beitrag fehlt");
      Object.assign(p, post, { ref, completed: p.completed + 1 });
    },
  };
  return { target, posts, state };
}

export function rssXml(title: string, items: { title: string; link: string; guid?: string; date?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://feed.test</link><description>x</description>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link.replace(/&/g, "&amp;")}</link>${i.guid ? `<guid isPermaLink="false">${i.guid}</guid>` : ""}${i.date ? `<pubDate>${i.date}</pubDate>` : ""}</item>`,
    )
    .join("")}</channel></rss>`;
}

export function articleHtml(text: string): string {
  return `<html><body><nav>Menü</nav><article><h1>Artikel</h1><p>${text}</p></article><footer>Impressum</footer></body></html>`;
}
