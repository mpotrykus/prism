/* Cross-server title identity: the same movie/show/episode can exist on more than one
   active Plex server (see this repo's CLAUDE.md - servers are otherwise entirely
   independent, no backend to reconcile them for us). Plex's own agent-matched `guid`
   (stamped onto every raw item's `guid` field by Plex itself, read by catalog.js's
   mapItem) is the identity key used here to collapse duplicate raw items - from
   different servers, or occasionally the same server via two different fetches - down to
   one representative before they're ever mapped/rendered.

   Operates on RAW Plex metadata objects (the ones data.js's plexFetch stamps with
   `__server`), not on already-mapped card items - callers run this over whatever raw list
   they've already assembled, right before slicing/mapping it into a row, so a dedup never
   costs a row a slot it didn't need to lose. Deliberately network-free, like catalog.js -
   see that file's own header comment for why. */

/* Which of a guid-group's raw items becomes the representative shown in the row - its own
   art/metadata is what the collapsed poster displays. Prefers the owned server (same
   convention as data.js's primaryServer), falling back to whichever came first. */
function pickRepresentative(group) {
  return group.find((m) => m.__server?.owned) || group[0];
}

/* {server, ratingKey, key} per raw item in a guid-group, owned server first, ONE ENTRY
   PER SERVER - this is what ends up on the mapped item as `sources` (see catalog.js's
   mapItem), which the info modal's "available on" tag and the player's server-grouped
   quality menu both read directly, no extra fetch needed at either of those points.
   Deduped by server id here rather than trusting the group to already be one-item-per-
   server: a title tagged with more than one genre lands in more than one genre bucket
   from the SAME section/server (see catalog.js's buildRecommendedRaw/buildPopularRaw,
   which flatten every genre bucket together before this ever collapses them), so a guid-
   group can legitimately contain two-plus raw items that are really the same server's
   same copy - without this, that server would get listed two-plus times in `sources`. */
export function resolveSources(group) {
  const bySeverId = new Map();
  for (const m of group) {
    const sid = m.__server?.id ?? m.__server?.url ?? m;
    if (!bySeverId.has(sid)) bySeverId.set(sid, m);
  }
  return [...bySeverId.values()]
    .sort((a, b) => (b.__server?.owned ? 1 : 0) - (a.__server?.owned ? 1 : 0))
    .map((m) => ({ server: m.__server || null, ratingKey: m.ratingKey, key: m.key }));
}

/* Second line of defense against the same duplicate-server problem resolveSources above
   guards against at the root - for any already-resolved `sources` array (e.g. read back
   off a mapped item well after collapseByGuid ran), so a caller never has to trust the
   shape blindly. Keeps the first occurrence per server id/url; an entry with neither
   (shouldn't happen - see mapItem's `server` fallback) is kept as its own unique key
   rather than being collapsed together with every other server-less entry. */
export function dedupeSourcesByServer(sources) {
  const seen = new Set();
  const result = [];
  (sources || []).forEach((s, i) => {
    const key = s.server?.id ?? s.server?.url ?? `unknown:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(s);
  });
  return result;
}

/* Groups a raw item list by guid (or by `keyFn(item)` when given) and collapses each
   group to its representative, with `__sources` attached only when a group actually has
   more than one member - a lone item (the common case) is returned untouched, not
   wrapped. Items with no key (missing guid, or a type Plex doesn't agent-match - e.g.
   search's "People" hub) pass through as-is rather than being dropped, so an unverified/
   missing guid fails open instead of silently losing content. Preserves the input's
   relative order.

   `keyFn` defaults to the item's own `guid` - right for a row of movies/episodes shown
   one-card-per-item. On-deck rows are per-SHOW cards backed by whichever episode is
   currently "next" on each server, and two servers watching the same show at different
   points have DIFFERENT current episodes - different episode guids - so the default
   per-item key alone doesn't collapse them (confirmed live: the same show duplicated in
   Continue Watching). data.js's fetchOnDeckRaw passes `(m) => m.grandparentGuid || m.guid`
   instead, so episodes collapse by their show's identity while movies (no
   grandparentGuid) still key off their own guid. */
export function collapseByGuid(rawItems, keyFn = (m) => m.guid) {
  if (!rawItems?.length) return rawItems || [];
  const byKey = new Map();
  for (const m of rawItems) {
    const key = keyFn(m);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const seen = new Set();
  const result = [];
  for (const m of rawItems) {
    const key = keyFn(m);
    if (!key) {
      result.push(m);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const group = byKey.get(key);
    const rep = pickRepresentative(group);
    if (group.length > 1) rep.__sources = resolveSources(group);
    result.push(rep);
  }
  return result;
}

/* Pairs one server's episode list (a show already known to be cross-server, via its own
   guid match - see collapseByGuid) against each OTHER source server's own episode listing
   for that same show, so a per-episode "available on"/quality-menu experience doesn't
   need its own separate show-level match. Matches by the episode's own `guid` first,
   falling back to season+episode number when a guid is missing or doesn't hit - some
   scrapers/agents don't expose one per-episode the same way they do per-show/movie, this
   is unverified against a real account (see this file's own header comment on guid
   format), so the fallback exists to fail open rather than silently show no cross-server
   version for an episode that really does have one.

   `otherEpisodesByServer` is `[{server, episodes}]`, one entry per other source server's
   own /allLeaves listing for the matched show. Returns Map<ratingKey, sources[]> - only
   episodes that matched on at least one other server appear in it at all, own-server
   entry included, so a caller can do `matches.get(ratingKey) || item.sources` uniformly. */
export function matchEpisodesAcrossServers(ownEpisodes, ownServer, otherEpisodesByServer) {
  const result = new Map();
  for (const ep of ownEpisodes) {
    const matches = [];
    for (const { server, episodes } of otherEpisodesByServer) {
      const match =
        (ep.guid && episodes.find((o) => o.guid === ep.guid)) ||
        episodes.find((o) => o.parentIndex === ep.parentIndex && o.index === ep.index);
      if (match) matches.push({ server, ratingKey: match.ratingKey, key: match.key });
    }
    if (matches.length) {
      result.set(String(ep.ratingKey), [{ server: ownServer, ratingKey: ep.ratingKey, key: ep.key }, ...matches]);
    }
  }
  return result;
}
