/**
 * Admin-Bereich „News“ für Seiten aus der SSR-Vorlage. Reiter Queue, Profile, Einstellungen, Protokoll.
 *
 * Einbau in der Seite (Beispiel):
 *   const utils = trpc.useUtils();
 *   <NewsAdmin client={utils.client.news} notify={{ success: toast.success, error: toast.error }} />
 *
 * Nur Typen aus dem Server-Teil importieren, sonst landen Datenbank- und Bildbibliotheken im Browser.
 * Gestaltet mit den Theme-Klassen der Vorlage (bg-card, border, text-muted-foreground, bg-primary …),
 * die Seite muss diese Datei für Tailwind freigeben (`@source` auf den Paketordner).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { NewsClient, NewsOverview, QueueDetail, QueueListItem, RunSummary } from "../service";
import type { Category, QueueStatus } from "../../core/types";
import type { Profile, ProfileConfig, SiteSettings } from "../../core/settings";

export interface NewsAdminProps {
  client: NewsClient;
  notify?: { success: (msg: string) => void; error: (msg: string) => void };
  /** Link „Zurück zum Dashboard“ */
  homeHref?: string;
}

type Tab = "queue" | "profiles" | "settings" | "runs";

const STATUS_LABEL: Record<QueueStatus, string> = {
  new: "Neu",
  crawled: "Gelesen",
  classified: "Geschrieben",
  approved: "Freigegeben",
  published: "Veröffentlicht",
  rejected: "Aussortiert",
  failed: "Fehler",
};
const STATUS_ORDER: QueueStatus[] = ["classified", "approved", "published", "new", "crawled", "failed", "rejected"];
const STATUS_TONE: Record<QueueStatus, string> = {
  new: "bg-muted text-foreground",
  crawled: "bg-muted text-foreground",
  classified: "bg-amber-100 text-amber-900",
  approved: "bg-sky-100 text-sky-900",
  published: "bg-green-100 text-green-900",
  rejected: "bg-muted text-muted-foreground",
  failed: "bg-red-100 text-red-900",
};
const RUN_LABEL: Record<RunSummary["status"], string> = { running: "läuft", completed: "abgeschlossen", failed: "mit Fehlern", locked: "übersprungen" };
const INTERVALS: [SiteSettings["cronInterval"], string][] = [
  ["15min", "alle 15 Minuten"],
  ["30min", "alle 30 Minuten"],
  ["hourly", "stündlich"],
  ["twicedaily", "zweimal täglich"],
  ["daily", "täglich"],
];
const LENGTHS: [ProfileConfig["rssLengths"][number], string][] = [
  ["short", "kurz (300 bis 500 Wörter)"],
  ["medium", "mittel (500 bis 800)"],
  ["long", "lang (800 bis 1200)"],
];

const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── kleine Bausteine ───────────────────────────────────────────────────────────────────────────

function Btn({ children, onClick, kind = "default", disabled, type = "button", title }: { children: ReactNode; onClick?: () => void; kind?: "primary" | "default" | "danger"; disabled?: boolean; type?: "button" | "submit"; title?: string }) {
  const cls =
    kind === "primary"
      ? "bg-primary text-primary-foreground hover:opacity-90"
      : kind === "danger"
        ? "border border-red-300 text-red-700 hover:bg-red-50"
        : "border bg-background hover:bg-muted";
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${cls}`}>
      {children}
    </button>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border bg-card p-4 md:p-5 ${className}`}>{children}</div>;
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const inputCls = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40";

function TextInput({ value, onChange, placeholder, type = "text" }: { value: string | number; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input className={inputCls} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function TextArea({ value, onChange, rows = 4, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea className={`${inputCls} font-mono text-[13px]`} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

// ─── Hauptseite ─────────────────────────────────────────────────────────────────────────────────

export function NewsAdmin({ client, notify, homeHref = "/" }: NewsAdminProps) {
  const [tab, setTab] = useState<Tab>("queue");
  const toast = notify ?? { success: () => undefined, error: (m: string) => console.error(m) };
  const overview = useLoad(() => client.overview.query({}), []);
  const ov = overview.data;

  // Während ein Lauf läuft, alle 4 Sekunden nachsehen
  useEffect(() => {
    if (!ov?.running) return;
    const t = setInterval(overview.reload, 4000);
    return () => clearInterval(t);
  }, [ov?.running, overview.reload]);

  const start = async (braveOnly: boolean) => {
    try {
      await client.start.mutate({ braveOnly });
      toast.success(braveOnly ? "Brave-Suche gestartet. Ergebnis im Protokoll." : "Lauf gestartet. Ergebnis im Protokoll.");
      setTimeout(overview.reload, 1500);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div>
      <div className="mb-6">
        <a href={homeHref} className="mb-2 inline-block text-sm text-muted-foreground hover:text-foreground">
          ← Zurück zum Dashboard
        </a>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">News</h1>
            <p className="mt-1 max-w-3xl text-muted-foreground">Meldungen aus RSS und Brave-Themensuche, per KI neu geschrieben. Version {ov?.version ?? "…"}.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn kind="primary" onClick={() => start(false)} disabled={!ov || ov.running}>
              Lauf jetzt starten
            </Btn>
            <Btn onClick={() => start(true)} disabled={!ov || ov.running || !ov.keys.brave} title={ov && !ov.keys.brave ? "BRAVE_API_KEY fehlt in der .env" : undefined}>
              Brave-Themen jetzt suchen
            </Btn>
          </div>
        </div>
      </div>

      {overview.error ? <Card className="mb-4 border-red-300 text-red-800">News-Bereich nicht erreichbar: {overview.error}</Card> : null}
      {ov ? <OverviewBar ov={ov} /> : null}

      <div className="mb-4 flex flex-wrap gap-1 border-b" role="tablist">
        {(
          [
            ["queue", "Queue"],
            ["profiles", "Profile"],
            ["settings", "Einstellungen"],
            ["runs", "Protokoll"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {l}
            {k === "queue" && ov?.waiting ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{ov.waiting}</span> : null}
          </button>
        ))}
      </div>

      {tab === "queue" ? <QueueTab client={client} toast={toast} onChange={overview.reload} requireApproval={ov?.settings.requireApproval ?? true} /> : null}
      {tab === "profiles" ? <ProfilesTab client={client} toast={toast} onChange={overview.reload} /> : null}
      {tab === "settings" ? <SettingsTab client={client} toast={toast} onChange={overview.reload} keys={ov?.keys} /> : null}
      {tab === "runs" ? <RunsTab client={client} running={ov?.running ?? false} /> : null}
    </div>
  );
}

function OverviewBar({ ov }: { ov: NewsOverview }) {
  const missing = [!ov.keys.llm && "KI-Schlüssel", !ov.keys.brave && "BRAVE_API_KEY", ov.settings.imagesEnabled && !ov.keys.fal && !ov.keys.openrouter && "FAL_KEY", ov.settings.requireApproval && !ov.keys.mail && "Mailversand"].filter(Boolean);
  const limit = (used: number, max: number) => (max > 0 ? `${used} von ${max}` : `${used}`);
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-4">
      <Card>
        <div className="text-sm text-muted-foreground">Warten auf Freigabe</div>
        <div className="text-2xl font-extrabold">{ov.settings.requireApproval ? ov.waiting : "aus"}</div>
      </Card>
      <Card>
        <div className="text-sm text-muted-foreground">Letzter Lauf</div>
        <div className="font-semibold">{ov.lastRun ? `${fmtDate(ov.lastRun.startedAt)} · ${RUN_LABEL[ov.lastRun.status]}` : "noch keiner"}</div>
        {ov.running ? <div className="text-xs text-amber-700">läuft gerade{ov.lastRun?.step ? `: ${ov.lastRun.step}` : ""}</div> : null}
      </Card>
      <Card>
        <div className="text-sm text-muted-foreground">Heute verbraucht</div>
        <div className="text-sm">
          KI {limit(ov.usageToday.ai, ov.limits.ai)} · Brave {limit(ov.usageToday.brave, ov.limits.brave)} · Bilder {limit(ov.usageToday.image, ov.limits.image)}
        </div>
      </Card>
      <Card>
        <div className="text-sm text-muted-foreground">Profile</div>
        <div className="font-semibold">
          {ov.profiles.active} aktiv von {ov.profiles.total}
        </div>
        {missing.length ? <div className="text-xs text-red-700">Fehlt: {missing.join(", ")}</div> : null}
      </Card>
    </div>
  );
}

// ─── Queue ──────────────────────────────────────────────────────────────────────────────────────

type TabProps = { client: NewsClient; toast: NonNullable<NewsAdminProps["notify"]>; onChange: () => void };

function QueueTab({ client, toast, onChange, requireApproval }: TabProps & { requireApproval: boolean }) {
  const [status, setStatus] = useState<QueueStatus | null>(requireApproval ? "classified" : null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const profiles = useLoad(() => client.profiles.query({}), []);
  const list = useLoad(() => client.queue.query({ status, profileId, search: search.trim() || null, page, pageSize: 50 }), [status, profileId, search, page]);
  const profileName = useMemo(() => new Map((profiles.data ?? []).map((p) => [p.id, p.name])), [profiles.data]);
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 50));

  useEffect(() => setSelected(new Set()), [status, profileId, search, page]);

  const act = async (action: "approve" | "reject" | "retry" | "delete", ids: number[]) => {
    if (!ids.length) return;
    if (action === "delete" && !confirm(`${ids.length} Einträge endgültig löschen?`)) return;
    try {
      const { changed } = await client.bulk.mutate({ action, ids });
      const verb = { approve: "freigegeben", reject: "aussortiert", retry: "erneut eingereiht", delete: "gelöscht" }[action];
      toast.success(`${changed} ${changed === 1 ? "Eintrag" : "Einträge"} ${verb}.`);
      setSelected(new Set());
      list.reload();
      onChange();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const allChecked = items.length > 0 && items.every((i) => selected.has(i.id));
  const ids = [...selected];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <FilterChip active={status === null} onClick={() => (setStatus(null), setPage(1))} label="Alle" count={list.data ? Object.values(list.data.counts).reduce((a, b) => a + b, 0) : undefined} />
        {STATUS_ORDER.map((s) => (
          <FilterChip key={s} active={status === s} onClick={() => (setStatus(s), setPage(1))} label={s === "classified" && requireApproval ? "Wartet auf Freigabe" : STATUS_LABEL[s]} count={list.data?.counts[s]} />
        ))}
      </div>
      <div className="mb-3 flex flex-col gap-2 md:flex-row">
        <select className={`${inputCls} md:w-56`} value={profileId ?? ""} onChange={(e) => (setProfileId(e.target.value ? Number(e.target.value) : null), setPage(1))} aria-label="Profil">
          <option value="">Alle Profile</option>
          {(profiles.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input className={inputCls} placeholder="Suche in Titel und Quelle" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
      </div>

      {ids.length ? (
        <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-3 shadow-sm">
          <span className="text-sm font-semibold">{ids.length} ausgewählt</span>
          <Btn kind="primary" onClick={() => act("approve", ids)}>
            Freigeben
          </Btn>
          <Btn onClick={() => act("reject", ids)}>Aussortieren</Btn>
          <Btn onClick={() => act("retry", ids)}>Erneut versuchen</Btn>
          <Btn kind="danger" onClick={() => act("delete", ids)}>
            Löschen
          </Btn>
        </div>
      ) : null}

      {list.error ? <Card className="text-red-800">{list.error}</Card> : null}
      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="p-3">
                <input type="checkbox" aria-label="Alle auswählen" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />
              </th>
              <th className="p-3">Titel</th>
              <th className="p-3">Profil</th>
              <th className="p-3">Status</th>
              <th className="p-3">Kategorie</th>
              <th className="p-3">Angelegt</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <QueueRow
                key={i.id}
                item={i}
                profile={profileName.get(i.profileId) ?? `#${i.profileId}`}
                checked={selected.has(i.id)}
                onCheck={(v) => setSelected((old) => { const n = new Set(old); if (v) n.add(i.id); else n.delete(i.id); return n; })}
                open={open === i.id}
                onOpen={() => setOpen(open === i.id ? null : i.id)}
                client={client}
                onAction={(a) => act(a, [i.id])}
              />
            ))}
            {list.data && !items.length ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  Keine Einträge.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Btn disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Zurück
          </Btn>
          <span>
            Seite {page} von {pages}
          </span>
          <Btn disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Weiter
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button onClick={onClick} className={`rounded-full border px-3 py-1 text-sm ${active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>
      {label}
      {count !== undefined ? <span className="ml-1.5 opacity-70">{count}</span> : null}
    </button>
  );
}

function QueueRow({ item, profile, checked, onCheck, open, onOpen, client, onAction }: { item: QueueListItem; profile: string; checked: boolean; onCheck: (v: boolean) => void; open: boolean; onOpen: () => void; client: NewsClient; onAction: (a: "approve" | "reject" | "retry" | "delete") => void }) {
  return (
    <>
      <tr className="border-b align-top last:border-0 hover:bg-muted/40">
        <td className="p-3">
          <input type="checkbox" aria-label="Auswählen" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        </td>
        <td className="p-3">
          <button onClick={onOpen} className="text-left font-semibold hover:underline">
            {item.rewrittenTitle ?? item.titleOriginal}
          </button>
          <div className="text-xs text-muted-foreground">
            {item.kind === "brave" ? "Brave-Themensuche" : item.sourceName}
            {item.rewrittenTitle && item.rewrittenTitle !== item.titleOriginal ? ` · Original: ${item.titleOriginal}` : ""}
          </div>
          {item.error ? (
            <div className={`mt-1 text-xs ${item.status === "failed" || item.status === "rejected" ? "text-red-700" : "text-amber-700"}`}>
              {item.error}
              {item.attempts ? ` (Versuche: ${item.attempts})` : ""}
            </div>
          ) : null}
        </td>
        <td className="p-3 whitespace-nowrap">{profile}</td>
        <td className="p-3">
          <StatusBadge status={item.status} />
        </td>
        <td className="p-3">{item.categoryKey ?? ""}</td>
        <td className="p-3 whitespace-nowrap text-muted-foreground">{fmtDate(item.createdAt)}</td>
      </tr>
      {open ? (
        <tr className="border-b bg-muted/30">
          <td colSpan={6} className="p-4">
            <EntryDetail id={item.id} client={client} onAction={onAction} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EntryDetail({ id, client, onAction }: { id: number; client: NewsClient; onAction: (a: "approve" | "reject" | "retry" | "delete") => void }) {
  const { data, error } = useLoad(() => client.entry.query({ id }), [id]);
  if (error) return <div className="text-red-800">{error}</div>;
  if (!data) return <div className="text-muted-foreground">Lädt …</div>;
  const d: QueueDetail = data;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {d.imageRef ? <img src={d.imageRef} alt="" className="mb-3 max-h-56 rounded-xl border object-cover" /> : null}
        {d.contentHtml ? (
          <div className="prose prose-sm max-w-none rounded-xl border bg-background p-4" dangerouslySetInnerHTML={{ __html: d.contentHtml }} />
        ) : (
          <div className="text-muted-foreground">Noch kein Text geschrieben{d.fullContentChars ? ` (Quelltext: ${d.fullContentChars} Zeichen)` : ""}.</div>
        )}
      </div>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          {d.status === "classified" ? (
            <Btn kind="primary" onClick={() => onAction("approve")}>
              Freigeben
            </Btn>
          ) : null}
          {d.status !== "published" && d.status !== "rejected" ? <Btn onClick={() => onAction("reject")}>Aussortieren</Btn> : null}
          {d.status === "failed" || d.status === "rejected" ? <Btn onClick={() => onAction("retry")}>Erneut versuchen</Btn> : null}
          <Btn kind="danger" onClick={() => onAction("delete")}>
            Löschen
          </Btn>
        </div>
        {d.teaserText ? <Info label="Teaser" value={d.teaserText} /> : null}
        {d.seoTitle ? <Info label="SEO-Titel" value={`${d.seoTitle} (${d.seoTitle.length})`} /> : null}
        {d.seoDescription ? <Info label="SEO-Description" value={`${d.seoDescription} (${d.seoDescription.length})`} /> : null}
        {d.tags.length ? <Info label="Tags" value={d.tags.join(", ")} /> : null}
        {d.imageBriefing ? <Info label="Bildbriefing" value={d.imageBriefing} /> : null}
        <div>
          <div className="font-semibold">Quellen</div>
          <ul className="list-disc pl-5">
            {(d.sourceList.length ? d.sourceList : d.sourceUrl ? [{ title: d.sourceName, url: d.sourceUrl }] : []).map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
        {d.postRef ? <Info label="Beitrag" value={`#${d.postRef}`} /> : null}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold">{label}</div>
      <div className="text-muted-foreground">{value}</div>
    </div>
  );
}

// ─── Profile ────────────────────────────────────────────────────────────────────────────────────

function ProfilesTab({ client, toast, onChange }: TabProps) {
  const profiles = useLoad(() => client.profiles.query({}), []);
  const categories = useLoad(() => client.categories.query({}), []);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);

  if (editing) {
    return (
      <ProfileForm
        profile={editing === "new" ? null : editing}
        categories={categories.data ?? []}
        client={client}
        toast={toast}
        onDone={() => {
          setEditing(null);
          profiles.reload();
          onChange();
        }}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Btn kind="primary" onClick={() => setEditing("new")}>
          Neues Profil
        </Btn>
      </div>
      {(profiles.data ?? []).map((p) => (
        <Card key={p.id} className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-semibold">
              {p.name} {p.active ? <span className="ml-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-900">aktiv</span> : <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs">aus</span>}
            </div>
            <div className="text-sm text-muted-foreground">
              {p.config.feeds.length} Feeds · Brave {p.config.braveEnabled ? `an (${p.config.braveQueries.length} Suchbegriffe, ${p.config.bravePerDay} Themen am Tag)` : "aus"} · Ziel {p.config.dailyTarget} Artikel am Tag
              {p.config.fixedCategory ? ` · immer „${p.config.fixedCategory}“` : ""}
            </div>
          </div>
          <Btn onClick={() => setEditing(p)}>Bearbeiten</Btn>
        </Card>
      ))}
      {profiles.data && !profiles.data.length ? <Card className="text-muted-foreground">Noch kein Profil. Ohne aktives Profil sucht die Pipeline keine Meldungen.</Card> : null}
    </div>
  );
}

const EMPTY_CONFIG: ProfileConfig = {
  topicPrompt: "",
  feeds: [],
  importWindow: 2,
  rssLengths: ["short", "medium"],
  braveEnabled: false,
  braveQueries: [],
  braveDays: 3,
  bravePerDay: 3,
  braveStartHour: 8,
  braveEndHour: 22,
  braveCompareUrls: [],
  bravePrompt: "",
  braveLengths: ["medium", "long"],
  braveStructure: "",
  styleRss: null,
  styleBrave: null,
  fixedCategory: null,
  dailyTarget: 3,
};

function ProfileForm({ profile, categories, client, toast, onDone }: { profile: Profile | null; categories: Category[]; client: NewsClient; toast: TabProps["toast"]; onDone: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [active, setActive] = useState(profile?.active ?? false);
  const [c, setC] = useState<ProfileConfig>(profile?.config ?? EMPTY_CONFIG);
  const [feedTest, setFeedTest] = useState<string | null>(null);
  const set = <K extends keyof ProfileConfig>(k: K, v: ProfileConfig[K]) => setC((old) => ({ ...old, [k]: v }));
  const lines = (v: string[]) => v.join("\n");
  const toLines = (v: string) => v.split("\n");
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const toggleLength = (key: "rssLengths" | "braveLengths", t: ProfileConfig["rssLengths"][number], on: boolean) =>
    set(key, on ? [...new Set([...c[key], t])] : c[key].filter((x) => x !== t));

  const save = async () => {
    try {
      const clean = { ...c, feeds: c.feeds.map((x) => x.trim()).filter(Boolean), braveQueries: c.braveQueries.map((x) => x.trim()).filter(Boolean), braveCompareUrls: c.braveCompareUrls.map((x) => x.trim()).filter(Boolean) };
      await client.saveProfile.mutate({ id: profile?.id ?? null, name, active, config: clean });
      toast.success("Profil gespeichert.");
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  const remove = async () => {
    if (!profile || !confirm(`Profil „${profile.name}“ löschen? Vorhandene Einträge bleiben in der Queue.`)) return;
    try {
      await client.deleteProfile.mutate({ id: profile.id });
      toast.success("Profil gelöscht.");
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  const testFeeds = async () => {
    const urls = c.feeds.map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return setFeedTest("Keine Feeds eingetragen.");
    setFeedTest("Prüfe …");
    const out: string[] = [];
    for (const url of urls) {
      const r = await client.testFeed.mutate({ url });
      out.push(r.ok ? `✓ ${url}: „${r.title}“, ${r.items.length ? `zuletzt „${r.items[0]!.title}“` : "keine Einträge"}` : `✗ ${url}: ${r.error}`);
    }
    setFeedTest(out.join("\n"));
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <TextInput value={name} onChange={setName} placeholder="z. B. Neuheiten" />
          </Field>
          <div className="flex items-end gap-6 pb-2">
            <Toggle checked={active} onChange={setActive} label="Profil aktiv" />
          </div>
        </div>
        <Field label="Themenprofil" hint="Wer schreibt für wen, was ist relevant, was nicht. Die KI prüft jede Meldung dagegen.">
          <TextArea rows={8} value={c.topicPrompt} onChange={(v) => set("topicPrompt", v)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Artikelziel pro Tag">
            <TextInput type="number" value={c.dailyTarget} onChange={(v) => set("dailyTarget", num(v))} />
          </Field>
          <Field label="Feste Kategorie" hint="Leer = die KI wählt aus den Kategorien der Seite.">
            <select className={inputCls} value={c.fixedCategory ?? ""} onChange={(e) => set("fixedCategory", e.target.value || null)}>
              <option value="">KI wählt</option>
              {categories.map((k) => (
                <option key={k.key} value={k.name}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-lg font-bold">RSS</h2>
        <Field label="Feeds" hint="Eine Adresse pro Zeile. Nur Quellen, deren Inhalte übernommen werden dürfen.">
          <TextArea rows={4} value={lines(c.feeds)} onChange={(v) => set("feeds", toLines(v))} placeholder="https://…/rss" />
        </Field>
        <div className="flex flex-wrap items-start gap-3">
          <Btn onClick={testFeeds}>Feeds prüfen</Btn>
          {feedTest ? <pre className="flex-1 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{feedTest}</pre> : null}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Datumsfenster (Tage)">
            <TextInput type="number" value={c.importWindow} onChange={(v) => set("importWindow", num(v))} />
          </Field>
          <Field label="Längen für RSS-Artikel">
            <div className="flex flex-col gap-1">
              {LENGTHS.map(([t, l]) => (
                <Toggle key={t} checked={c.rssLengths.includes(t)} onChange={(on) => toggleLength("rssLengths", t, on)} label={l} />
              ))}
            </div>
          </Field>
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Brave-Themensuche</h2>
          <Toggle checked={c.braveEnabled} onChange={(v) => set("braveEnabled", v)} label="eingeschaltet" />
        </div>
        <Field label="Suchbegriffe" hint="Einer pro Zeile. Mit Sprachpräfix: de|Garmin Update. Ohne Präfix wird englisch gesucht.">
          <TextArea rows={4} value={lines(c.braveQueries)} onChange={(v) => set("braveQueries", toLines(v))} />
        </Field>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Themen pro Tag">
            <TextInput type="number" value={c.bravePerDay} onChange={(v) => set("bravePerDay", num(v))} />
          </Field>
          <Field label="Von (Uhr)">
            <TextInput type="number" value={c.braveStartHour} onChange={(v) => set("braveStartHour", num(v))} />
          </Field>
          <Field label="Bis (Uhr)">
            <TextInput type="number" value={c.braveEndHour} onChange={(v) => set("braveEndHour", num(v))} />
          </Field>
          <Field label="Zeitraum (Tage)">
            <TextInput type="number" value={c.braveDays} onChange={(v) => set("braveDays", num(v))} />
          </Field>
        </div>
        <Field label="Längen für Brave-Artikel">
          <div className="flex flex-wrap gap-4">
            {LENGTHS.map(([t, l]) => (
              <Toggle key={t} checked={c.braveLengths.includes(t)} onChange={(on) => toggleLength("braveLengths", t, on)} label={l} />
            ))}
          </div>
        </Field>
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Erweitert</summary>
          <div className="mt-3 space-y-4">
            <Field label="Auswahl-Prompt" hint="Leer = Standardtext aus KNP.">
              <TextArea rows={6} value={c.bravePrompt} onChange={(v) => set("bravePrompt", v)} />
            </Field>
            <Field label="Gliederung der Artikel" hint="Leer = Einstieg, Bedeutung, Anleitung, Tipps, Fazit.">
              <TextArea rows={3} value={c.braveStructure} onChange={(v) => set("braveStructure", v)} />
            </Field>
            <Field label="Vergleichsseiten" hint="Überschriften dieser Seiten gelten als schon behandelt. Eine Adresse pro Zeile.">
              <TextArea rows={3} value={lines(c.braveCompareUrls)} onChange={(v) => set("braveCompareUrls", toLines(v))} />
            </Field>
          </div>
        </details>
      </Card>

      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <Btn kind="primary" onClick={save} disabled={!name.trim()}>
            Speichern
          </Btn>
          <Btn onClick={onDone}>Abbrechen</Btn>
        </div>
        {profile ? (
          <Btn kind="danger" onClick={remove}>
            Profil löschen
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

// ─── Einstellungen ──────────────────────────────────────────────────────────────────────────────

function SettingsTab({ client, toast, onChange, keys }: TabProps & { keys?: NewsOverview["keys"] }) {
  const loaded = useLoad(() => client.settings.query({}), []);
  const categories = useLoad(() => client.categories.query({}), []);
  const [s, setS] = useState<SiteSettings | null>(null);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  if (!s) return <div className="text-muted-foreground">Lädt …</div>;
  const set = <K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) => setS((old) => (old ? { ...old, [k]: v } : old));
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const save = async () => {
    try {
      setS(await client.saveSettings.mutate({ settings: s as unknown as Record<string, unknown> }));
      toast.success("Einstellungen gespeichert.");
      onChange();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <h2 className="text-lg font-bold">Veröffentlichung</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Toggle checked={s.requireApproval} onChange={(v) => set("requireApproval", v)} label="Manuelle Freigabe (empfohlen)" />
          <Toggle checked={s.notifyWaiting} onChange={(v) => set("notifyWaiting", v)} label={`Mail bei wartenden Artikeln${keys && !keys.mail ? " (Mailversand fehlt)" : ""}`} />
          <Field label="Status neuer Beiträge">
            <Select value={s.postStatus} onChange={(v) => set("postStatus", v)} options={[["published", "veröffentlicht"], ["draft", "Entwurf"]]} />
          </Field>
          <Field label="Autor" hint="Leer = Standardautor der Seite.">
            <TextInput value={s.author ?? ""} onChange={(v) => set("author", v.trim() || null)} />
          </Field>
          <Field label="Kategorie, wenn die KI keine passende wählt">
            <select className={inputCls} value={s.fallbackCategory} onChange={(e) => set("fallbackCategory", e.target.value)}>
              {(categories.data ?? [{ key: s.fallbackCategory, name: s.fallbackCategory }]).map((k) => (
                <option key={k.key} value={k.name}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nicht freigegebene verfallen nach (Tagen)">
            <TextInput type="number" value={s.expireDays} onChange={(v) => set("expireDays", num(v))} />
          </Field>
          <Toggle checked={s.addSourceLink} onChange={(v) => set("addSourceLink", v)} label="Quellen unter dem Artikel nennen" />
          <Toggle checked={s.tagsEnabled} onChange={(v) => set("tagsEnabled", v)} label="Tags erzeugen" />
        </div>
        <Field label="KI-Hinweis unter dem Artikel" hint="Leer = kein Hinweis.">
          <TextInput value={s.aiDisclosure} onChange={(v) => set("aiDisclosure", v)} />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-lg font-bold">Ablauf und Grenzen</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Lauf-Intervall" hint="Das Cron-Skript läuft alle 15 Minuten und startet nur, wenn fällig.">
            <Select value={s.cronInterval} onChange={(v) => set("cronInterval", v)} options={INTERVALS} />
          </Field>
          <Field label="Einträge je Schritt und Lauf">
            <TextInput type="number" value={s.maxPerRun} onChange={(v) => set("maxPerRun", num(v))} />
          </Field>
          <Field label="Tags je Artikel">
            <TextInput type="number" value={s.maxTags} onChange={(v) => set("maxTags", num(v))} />
          </Field>
          <Field label="KI-Aufrufe pro Tag" hint="0 = ohne Limit">
            <TextInput type="number" value={s.dailyAiLimit} onChange={(v) => set("dailyAiLimit", num(v))} />
          </Field>
          <Field label="Brave-Anfragen pro Tag" hint="0 = ohne Limit">
            <TextInput type="number" value={s.dailyBraveLimit} onChange={(v) => set("dailyBraveLimit", num(v))} />
          </Field>
          <Field label="Pause zwischen Brave-Anfragen (ms)" hint="1100 für den Gratis-Tarif, sonst 100 bis 200">
            <TextInput type="number" value={s.braveDelayMs} onChange={(v) => set("braveDelayMs", num(v))} />
          </Field>
          <Field label="Sprache der Artikel">
            <TextInput value={s.language} onChange={(v) => set("language", v)} />
          </Field>
          <Field label="Zeitzone">
            <TextInput value={s.timezone} onChange={(v) => set("timezone", v)} />
          </Field>
          <Field label="Wartung und Hinweis-Mail ab (Uhr)">
            <TextInput type="number" value={s.maintenanceHour} onChange={(v) => set("maintenanceHour", num(v))} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Teaserbilder</h2>
          <Toggle checked={s.imagesEnabled} onChange={(v) => set("imagesEnabled", v)} label="eingeschaltet" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Anbieter" hint={keys ? `Schlüssel: fal.ai ${keys.fal ? "hinterlegt" : "fehlt"}, OpenRouter ${keys.openrouter ? "hinterlegt" : "fehlt"}` : undefined}>
            <Select value={s.imageProvider} onChange={(v) => set("imageProvider", v)} options={[["fal", "fal.ai"], ["openrouter", "OpenRouter"]]} />
          </Field>
          <Field label="Modell" hint="Leer = Standard des Anbieters">
            <TextInput value={s.imageModel} onChange={(v) => set("imageModel", v)} />
          </Field>
          <Field label="Bilder pro Tag" hint="0 = ohne Limit">
            <TextInput type="number" value={s.dailyImageLimit} onChange={(v) => set("dailyImageLimit", num(v))} />
          </Field>
        </div>
      </Card>

      <Btn kind="primary" onClick={save}>
        Einstellungen speichern
      </Btn>
    </div>
  );
}

// ─── Protokoll ──────────────────────────────────────────────────────────────────────────────────

function RunsTab({ client, running }: { client: NewsClient; running: boolean }) {
  const runs = useLoad(() => client.runs.query({ limit: 50 }), []);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(runs.reload, 4000);
    return () => clearInterval(t);
  }, [running, runs.reload]);
  return (
    <div className="space-y-2">
      {(runs.data ?? []).map((r) => (
        <Card key={r.id} className="p-0 md:p-0">
          <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-4 text-left text-sm">
            <span className="font-semibold">{fmtDate(r.startedAt)}</span>
            <span className={r.status === "failed" ? "text-red-700" : r.status === "running" ? "text-amber-700" : "text-muted-foreground"}>{RUN_LABEL[r.status]}</span>
            <span className="text-muted-foreground">{r.trigger === "manual" ? "von Hand" : "Zeitplan"}</span>
            {r.step ? <span className="text-muted-foreground">Schritt {r.step}</span> : null}
            {r.message ? <span className="text-muted-foreground">{r.message}</span> : null}
          </button>
          {open === r.id ? <RunLog id={r.id} client={client} /> : null}
        </Card>
      ))}
      {runs.data && !runs.data.length ? <Card className="text-muted-foreground">Noch kein Lauf.</Card> : null}
    </div>
  );
}

function RunLog({ id, client }: { id: number; client: NewsClient }) {
  const { data } = useLoad(() => client.run.query({ id }), [id]);
  if (!data) return <div className="px-4 pb-4 text-sm text-muted-foreground">Lädt …</div>;
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t px-4 py-3 text-xs">{data.log.join("\n") || "Leer."}</pre>;
}

export default NewsAdmin;
