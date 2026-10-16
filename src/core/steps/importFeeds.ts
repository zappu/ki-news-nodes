/**
 * Schritt RSS-Import: je aktivem Profil die Feeds lesen, die ersten 30 Items im Datumsfenster übernehmen,
 * Duplikate über GUID und normalisierte URL überspringen (über alle Profile der Seite).
 * Ein fehlerhafter Feed wird protokolliert und übersprungen.
 */
import type { PipelineContext, RunState, StepResult } from "../context";
import { fetchFeed } from "../feeds";
import { hostOf, isHttpUrl, rssGuid, urlHash } from "../urls";

export const ITEMS_PER_FEED = 30;

export async function importFeeds(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  let feeds = 0;
  let failedFeeds = 0;
  let added = 0;
  let duplicates = 0;
  let tooOld = 0;

  for (const profileId of run.activeProfileIds) {
    const profile = run.profiles.get(profileId)!;
    const cutoff = run.now().getTime() - profile.config.importWindow * 86_400_000;
    for (const feedUrl of profile.config.feeds) {
      if (!isHttpUrl(feedUrl)) {
        run.logger.log(`RSS-Import (${profile.name}): ungültige Feed-URL übersprungen: ${feedUrl.slice(0, 200)}`);
        continue;
      }
      feeds++;
      let feed;
      try {
        feed = await fetchFeed(ctx.http, feedUrl);
      } catch (e) {
        failedFeeds++;
        run.logger.log(`RSS-Import (${profile.name}): Feed ${feedUrl} fehlgeschlagen: ${(e as Error).message}`);
        continue;
      }
      for (const item of feed.items.slice(0, ITEMS_PER_FEED)) {
        if (!item.link || !isHttpUrl(item.link)) continue;
        if (item.date && item.date.getTime() < cutoff) {
          tooOld++;
          continue;
        }
        const guid = rssGuid(item.guid, item.link);
        const hash = urlHash(item.link);
        if ((await ctx.store.guidExists(ctx.siteId, guid)) || (await ctx.store.urlHashExists(ctx.siteId, hash))) {
          duplicates++;
          continue;
        }
        const id = await ctx.store.insertEntry({
          siteId: ctx.siteId,
          profileId,
          guid,
          urlHash: hash,
          feedUrl,
          sourceUrl: item.link,
          sourceName: feed.title || hostOf(feedUrl),
          titleOriginal: item.title || item.link,
          publishedAt: item.date,
        });
        if (id) added++;
        else duplicates++;
      }
    }
  }
  return {
    summary: `RSS-Import: ${added} neue Einträge aus ${feeds} Feeds${failedFeeds ? `, ${failedFeeds} Feeds mit Fehler` : ""} (${duplicates} schon bekannt, ${tooOld} zu alt).`,
  };
}
