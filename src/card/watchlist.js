/* Plex "My List" (watchlist) add/remove. Both actions go through
   discover.provider.plex.tv, scoped by account token (not the server-specific
   plex_token) - see plex-auth.js's Plex Home comments for why account-level vs.
   server-level tokens matter. A watchlist ratingKey lives in a different ID space than
   this server's /library/metadata, so it has to be re-resolved by normalized title
   match (see logic/watchlist-match.js) before either action can target it. */
import { normalizeTitle } from "./logic/watchlist-match.js";

/* Single paint routine for the watchlist button's "added" state - previously
   duplicated separately in the hero, poster, and title-info render paths. */
export function paintWatchlistButton(btnEl, added) {
  btnEl.classList.toggle("added", added);
  btnEl.textContent = added ? "✓" : "+";
  btnEl.setAttribute("aria-label", added ? "Remove from My List" : "Add to My List");
}

async function resolveDiscoverRatingKey(item, plexAccountToken) {
  try {
    const url = new URL("https://discover.provider.plex.tv/library/search");
    url.searchParams.set("query", item.title);
    url.searchParams.set("searchTypes", item.type === "show" ? "tv" : "movies");
    url.searchParams.set("searchProviders", "discover");
    url.searchParams.set("limit", "10");
    url.searchParams.set("X-Plex-Token", plexAccountToken);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data?.MediaContainer?.SearchResults || [])
      .flatMap((g) => g.SearchResult || [])
      .map((r) => r.Metadata)
      .filter(Boolean);
    const norm = normalizeTitle(item.title);
    const exact = results.find((m) => normalizeTitle(m.title) === norm && (!item.year || m.year === item.year));
    return (exact || results[0])?.ratingKey || null;
  } catch (e) {
    return null;
  }
}

async function mutateWatchlist(item, btnEl, { plexAccountToken, action, onSuccess }) {
  if (btnEl.dataset.busy) return;
  btnEl.dataset.busy = "1";
  btnEl.classList.add("busy");
  try {
    const ratingKey = await resolveDiscoverRatingKey(item, plexAccountToken);
    if (!ratingKey) throw new Error(`no discover match`);
    const url = new URL(`https://discover.provider.plex.tv/actions/${action}`);
    url.searchParams.set("ratingKey", ratingKey);
    url.searchParams.set("X-Plex-Token", plexAccountToken);
    const res = await fetch(url, { method: "PUT", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${action} failed`);
    btnEl.classList.remove("busy");
    paintWatchlistButton(btnEl, action === "addToWatchlist");
    await onSuccess?.();
  } catch (e) {
    btnEl.classList.remove("busy");
    btnEl.classList.add("error");
    setTimeout(() => btnEl.classList.remove("error"), 1500);
  } finally {
    delete btnEl.dataset.busy;
  }
}

export function addToWatchlist(item, btnEl, { plexAccountToken, onSuccess }) {
  return mutateWatchlist(item, btnEl, { plexAccountToken, action: "addToWatchlist", onSuccess });
}

export function removeFromWatchlist(item, btnEl, { plexAccountToken, onSuccess }) {
  return mutateWatchlist(item, btnEl, { plexAccountToken, action: "removeFromWatchlist", onSuccess });
}
