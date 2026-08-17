import { parseYearQuery, buildGenreMatchHubs, buildReasonMatchHubs, SEARCH_REASON_LABELS } from "./logic/search.js";
import { plexFetch } from "./data.js";
import { releasePosterImgClaims } from "./rows.js";

/* Search: the search-box input handling, the /hubs/search + genre/year/facet hub
   building, and the results-page render. Takes the PlexNetflixCard instance as an
   explicit first argument (same pattern as data.js) since these read this._config/
   this._genreBySection/this._studioFacets etc. and write this._lastSearchQuery/
   this._lastSearchHubs so Back-button re-renders reuse the cached hubs. */

const SEARCH_HUB_LIMIT = 24;
/* "See All" section expansion - large enough that no single library section's search
   hub is likely to actually hit this ceiling. */
const SEARCH_EXPAND_LIMIT = 500;

export function onSearchInput(card) {
  clearTimeout(card._searchTimer);
  const q = card._searchInput.value.trim();
  if (!q) {
    exitSearch(card);
    return;
  }
  if (card._currentView !== "search") enterSearch(card);
  card._searchTimer = setTimeout(() => runSearch(card, q), 300);
}

function enterSearch(card) {
  card._preSearchView = card._currentView;
  card._currentView = "search";
  card._navItems.forEach((n) => n.classList.remove("active"));
  card._showHero();
  card._renderLoading();
}

export function exitSearch(card) {
  if (card._currentView !== "search") return;
  card._currentView = card._preSearchView || "home";
  card._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === card._currentView));
  card._renderCurrentView();
  card._advanceHero();
}

async function runSearch(card, q) {
  /* Typing slowly lets each keystroke's own 300ms debounce fully elapse before the next
     one lands, so onSearchInput's clearTimeout never gets a chance to cancel anything -
     every intermediate query (e.g. "R", "Ri", "Rid", ...) fires its own independent
     in-flight fetch. Those responses can resolve out of order (an earlier, broader query
     taking longer than a later, narrower one), so without a sequence check the LAST
     response to land wins the render even if it's for a stale query - confirmed
     empirically: "Riddi" typed slowly showed "R"'s broader result set. */
  const seq = ++card._searchSeq;
  try {
    const hubs = await buildSearchHubs(card, q, SEARCH_HUB_LIMIT, card._config.row_size);
    if (card._currentView !== "search" || seq !== card._searchSeq) return;
    card._lastSearchQuery = q;
    card._lastSearchHubs = hubs;
    renderSearchPage(card, hubs);
  } catch (e) {
    if (card._currentView !== "search" || seq !== card._searchSeq) return;
    card._rowsEl.innerHTML = `<div class="empty">${card._emptyStateHtml("Search failed")}</div>`;
  }
}

/* Shared by both the normal (capped) search page and "See All" section expansion - the
   two differ only in the limits passed to Plex's hub search and to the locally-built
   genre/year/facet hubs. */
async function buildSearchHubs(card, q, hubLimit, rowLimit) {
  /* /hubs/search ignores X-Plex-Container-Size for its per-hub result count (silently
     caps at 3 regardless of that value) - the real per-hub limit param is `limit`,
     confirmed empirically. */
  const data = await plexFetch(card, "/hubs/search", { query: q, limit: hubLimit });
  const hubs = (data?.MediaContainer?.Hub || []).filter((h) => (h.Metadata || []).length);
  const reasonHubs = buildReasonMatchHubs(hubs, hubLimit);
  const otherHubs = hubs
    .map((h) => {
      const rawLen = (h.Metadata || []).length;
      return {
        ...h,
        Metadata: (h.Metadata || []).filter((m) => !SEARCH_REASON_LABELS[m.reason]),
        /* /hubs/search DOES honor `limit` (unlike X-Plex-Container-Size elsewhere), so
           hitting it exactly is a reliable "there may be more" signal - there's no
           per-hub totalSize in this response to check precisely. */
        hasMore: rawLen >= hubLimit,
      };
    })
    .filter((h) => h.Metadata.length);
  const genreHubs = buildGenreMatchHubs(q, rowLimit, {
    genreBySection: card._genreBySection,
  });
  const yearHubs = await buildYearMatchHubs(card, q, rowLimit);
  const facetHubs = await buildFacetMatchHubs(card, q, rowLimit);
  return [...otherHubs, ...reasonHubs, ...genreHubs, ...yearHubs, ...facetHubs];
}

async function expandSearchSection(card, title) {
  const q = card._lastSearchQuery;
  if (!q) return;
  card._renderLoading();
  try {
    const hubs = await buildSearchHubs(card, q, SEARCH_EXPAND_LIMIT, SEARCH_EXPAND_LIMIT);
    if (card._currentView !== "search") return;
    const hub = hubs.find((h) => h.title === title);
    renderSearchPage(card, hub ? [hub] : [], { expanded: true });
  } catch (e) {
    if (card._currentView !== "search") return;
    card._rowsEl.innerHTML = `<div class="empty">${card._emptyStateHtml("Search failed")}</div>`;
  }
}

async function buildYearMatchHubs(card, query, limit) {
  const range = parseYearQuery(query);
  if (!range) return [];
  const [start, end] = range;
  /* Plex's advanced filter operators (>>/<< on the field name) are strict
     inequalities, so an inclusive range needs the bounds nudged by one - confirmed
     empirically against this server (year>>1989&year<<1996 returns exactly
     1990-1995). */
  const yearParams = start === end ? { year: start } : { "year>>": start - 1, "year<<": end + 1 };
  const perSection = await Promise.all(
    card._config.sections.map(async (s) => {
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/all`, {
          type: s.type,
          "X-Plex-Container-Size": limit,
          ...yearParams,
        });
        return data?.MediaContainer?.Metadata || [];
      } catch (e) {
        return [];
      }
    })
  );
  const items = perSection.flat();
  if (!items.length) return [];
  const title = start === end ? `Year ${start}` : `Year ${start}–${end}`;
  /* X-Plex-Container-Size is silently ignored on /library/sections/{key}/all (confirmed
     empirically, same as the /hubs/search quirk noted above) - Plex already returned
     the full matching set here, so `items.length` is the true total, not just what got
     requested, and the slice below is the only thing actually capping this row. */
  return [{ title, Metadata: items.slice(0, limit), hasMore: items.length > limit }];
}

async function buildFacetMatchHubs(card, query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matchFacets = (facets) => (facets || []).filter((f) => f.title.toLowerCase().includes(q));
  const jobs = [
    ...matchFacets(card._studioFacets).map((facet) => ({ facet, filterName: "studio", label: "Studio" })),
    ...matchFacets(card._collectionFacets).map((facet) => ({ facet, filterName: "collection", label: "Collection" })),
  ];
  const hubs = await Promise.all(
    jobs.map(async ({ facet, filterName, label }) => {
      const items = await fetchByFacet(card, facet, filterName, limit);
      /* fetchByFacet already returns everything Plex has for this facet (see its
         comment - X-Plex-Container-Size is ignored server-side and nothing slices the
         result afterward), so there's never anything left to reveal via "See All". */
      if (!items.length) return null;
      const hub = { title: `${label} "${facet.title}"`, Metadata: items, hasMore: false };
      if (filterName === "collection") {
        /* facet comes from the singular /collection facet-listing endpoint, which has
           no thumb - look the real poster up by title from the plural /collections
           fetch (data.js's fetchCollectionsRaw) instead, matched within the same
           section. */
        const match = (card._collectionsRaw || []).find(
          (c) => c.section.key === facet.section.key && c.title === facet.title
        );
        if (match?.thumb) hub.image = card._plexThumbUrl(match.thumb);
      }
      return hub;
    })
  );
  return hubs.filter(Boolean);
}

async function fetchByFacet(card, facet, filterName, limit) {
  try {
    /* facet.key comes back from Plex's own /studio and /collection directory listings
       already percent-escaped for direct reuse as a filter value (double-escaped for
       studio names with spaces, e.g. "Marvel%2520Studios") - it must be appended to the
       URL as-is, not passed through URLSearchParams/searchParams.set, which would
       re-encode the literal "%" characters and break the match. */
    const base = new URL(`${card._config.plex_url}/library/sections/${facet.section.key}/all`);
    base.searchParams.set("type", facet.section.type);
    base.searchParams.set("X-Plex-Container-Size", limit);
    base.searchParams.set("X-Plex-Token", card._config.plex_token);
    const res = await fetch(`${base.toString()}&${filterName}=${facet.key}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.MediaContainer?.Metadata || [];
  } catch (e) {
    return [];
  }
}

/* Row "See More" (see openRowSeeMore below) reuses this same expanded single-hub page -
   its back button can't reuse the default "return to the last search's hubs" behavior
   (there may be no prior search at all), so onBack/backLabel let a caller override both
   the label and the action while still getting the identical grid rendering. */
/* A browse row's "See More" card (rows.js's buildSeeMoreCard, wired up via row.hasMore/
   row.loadMore - see plex-netflix-card.js's _rowCtx.onSeeMoreRow) - not a real search, but
   reuses the exact same expanded single-hub grid page since that's already the codebase's
   "uncapped version of a row" UI (see expandSearchSection above). Borrows the "search"
   view's own re-render guard (data.js's loadAll/loadBackgroundData both skip their
   background re-renders while card._currentView === "search") so a background data
   refresh landing mid-view can't stomp this page back to the normal grid underneath it. */
export async function openRowSeeMore(card, row) {
  const returnView = card._currentView;
  card._preSearchView = returnView;
  card._currentView = "search";
  card._navItems.forEach((n) => n.classList.remove("active"));
  card._showHero();
  card._renderLoading();
  let rawItems = [];
  try {
    rawItems = (await row.loadMore?.()) || [];
  } catch (e) {
    rawItems = [];
  }
  if (card._currentView !== "search") return; // user navigated away while this was loading
  renderSearchPage(card, [{ title: row.title, Metadata: rawItems }], {
    expanded: true,
    backLabel: "← Back",
    onBack: () => card._exitSearch(),
  });
}

export function renderSearchPage(card, hubs, { expanded = false, onBack = null, backLabel = "← Back to all results" } = {}) {
  const visibleHubs = hubs.filter((hub) => (hub.Metadata || []).length);
  if (!visibleHubs.length) {
    card._rowsEl.innerHTML = `<div class="empty">${card._emptyStateHtml("No results")}</div>`;
    return;
  }
  /* The whole page (every hub's posters) is built fully detached below and only attached
     to card._rowsEl once at the very end - release claims now, before any poster in this
     pass is built, so a title that shows up in more than one hub (title match + genre
     match + collection match, etc. - common in search) gets a real clone for its repeat
     appearances instead of getPosterImg mistaking an earlier, still-detached sibling
     poster's img for "free" and stealing it. */
  releasePosterImgClaims();
  const page = document.createElement("div");
  page.className = "search-page";
  if (expanded) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "search-page-back";
    back.textContent = backLabel;
    back.addEventListener("click", () => {
      if (onBack) onBack();
      else if (card._lastSearchHubs) renderSearchPage(card, card._lastSearchHubs);
    });
    page.appendChild(back);
  }
  for (const hub of visibleHubs) {
    const group = document.createElement("div");
    group.className = "search-page-group";
    const header = document.createElement("div");
    header.className = "search-page-group-header";
    const h = document.createElement("div");
    h.className = "search-page-group-title";
    h.textContent = hub.title;
    if (hub.image) {
      const titleWrap = document.createElement("div");
      titleWrap.className = "search-page-group-title-wrap";
      const img = document.createElement("img");
      img.className = "search-page-group-image";
      img.loading = "lazy";
      img.src = hub.image;
      img.alt = "";
      titleWrap.appendChild(img);
      titleWrap.appendChild(h);
      header.appendChild(titleWrap);
    } else {
      header.appendChild(h);
    }
    if (!expanded && hub.hasMore) {
      const seeAll = document.createElement("button");
      seeAll.type = "button";
      seeAll.className = "search-page-see-all";
      seeAll.textContent = "See All";
      seeAll.addEventListener("click", () => expandSearchSection(card, hub.title));
      header.appendChild(seeAll);
    }
    group.appendChild(header);
    const grid = document.createElement("div");
    grid.className = "search-page-grid";
    for (const m of hub.Metadata || []) {
      const item = card._mapItem(m, false);
      grid.appendChild(card._buildPoster(item, "local"));
    }
    group.appendChild(grid);
    page.appendChild(group);
  }
  card._rowsEl.innerHTML = "";
  card._rowsEl.appendChild(page);
}
