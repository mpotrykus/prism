import { parseAiSectionIdeas } from "./logic/catalog.js";
import * as StreamingPlexAuth from "../../plex-auth.js";
import { loadPlain, savePlain } from "../../settings.js";
import { hasSecrets, loadSecrets, saveSecrets } from "../../vault.js";

/* Plex fetch/data-loading orchestration - the card's single "go get everything Home
   needs" entry point plus every raw fetch it fans out to. Takes the PlexNetflixCard
   instance as an explicit first argument (same pattern plex-player.js's native-bridge.js/
   web-fallback.js use) since these all read this._config and write the handful of
   `_xRaw`/`_xBySection` fields the row-building logic (logic/catalog.js) consumes. */

export async function plexFetch(card, path, params = {}) {
  const url = new URL(card._config.plex_url + path);
  Object.entries(params).forEach(([k, v]) => {
    /* Plex ANDs repeated same-key filter params (e.g. two `genre=` keys) rather than
       ORing them - array values let AI-generated multi-genre rows use that. */
    if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, vv));
    else url.searchParams.set(k, v);
  });
  url.searchParams.set("X-Plex-Token", card._config.plex_token);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Plex ${path} -> HTTP ${res.status}`);
  /* Action endpoints like /:/scrobble and /:/unscrobble respond 200 with an empty body,
     not JSON - res.json() throws on that (SyntaxError: Unexpected end of JSON input),
     which every caller's catch block then swallows as if the action itself had failed
     even though Plex already applied it server-side. */
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* "home"/"search" (or any unrecognized view) fall through to null, meaning "no single
   section" - callers treat that as "all sections". */
export function sectionForView(card, view) {
  if (typeof view !== "string" || !view.startsWith("section-")) return null;
  const key = Number(view.slice("section-".length));
  return (card._config.sections || []).find((s) => s.key === key) || null;
}

export function sectionsForView(card, view) {
  const section = sectionForView(card, view);
  return section ? [section] : card._config.sections;
}

export async function fetchOnDeckRaw(card) {
  try {
    const data = await plexFetch(card, "/library/onDeck");
    return data?.MediaContainer?.Metadata || [];
  } catch (e) {
    return [];
  }
}

export async function fetchWatchlistRaw(card) {
  try {
    const url = new URL("https://discover.provider.plex.tv/library/sections/watchlist/all");
    /* discover.provider.plex.tv is plex.tv's account-level Discover service, not the
       local server - it needs the account token (plex_account_token), not the
       server-specific plex_token, so this scopes correctly per switched Home profile
       instead of always reflecting whichever profile originally signed in. */
    url.searchParams.set("X-Plex-Token", card._config.plex_account_token);
    /* discover.provider.plex.tv defaults to a small page size (20) when
       X-Plex-Container-Size is omitted, silently truncating the row - unlike every other
       list endpoint in this file, this one doesn't skip the param "because it returns
       everything already". Per Plex's own docs, Start and Size must both be sent together
       to request paginated content. 100 is this endpoint's own hard cap (confirmed
       empirically - 101+ returns HTTP 400 "Invalid value provided for
       x-plex-container-size"), not an arbitrary choice - a genuinely 100+ item watchlist
       would need real pagination (repeat with an incrementing Start) to go further. */
    url.searchParams.set("X-Plex-Container-Start", 0);
    url.searchParams.set("X-Plex-Container-Size", 100);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.MediaContainer?.Metadata || [];
  } catch (e) {
    return [];
  }
}

async function fetchWatchHistoryRaw(card) {
  try {
    const data = await plexFetch(card, "/status/sessions/history/all", {
      sort: "viewedAt:desc",
      "X-Plex-Container-Size": 500,
    });
    return data?.MediaContainer?.Metadata || [];
  } catch (e) {
    return [];
  }
}

async function fetchRecentlyAddedRaw(card) {
  const rowSize = card._config.row_size;
  const perSection = await Promise.all(
    card._config.sections.map(async (s) => {
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/all`, {
          type: s.type,
          sort: "addedAt:desc",
          "X-Plex-Container-Size": rowSize,
        });
        return data?.MediaContainer?.Metadata || [];
      } catch (e) {
        return [];
      }
    })
  );
  return perSection.flat();
}

async function fetchCollectionsRaw(card) {
  /* Deliberately NOT the /library/sections/{key}/collection (singular) endpoint used by
     loadSearchFacets below - that one is Plex's filter-facet listing and only returns
     {key, title}, no ratingKey/thumb/childCount. The real collection objects (with
     posters) live at the plural /collections endpoint, under MediaContainer.Metadata.
     No `type` param here, deliberately - passing the section's type (e.g. 1 for movie)
     makes Plex return every movie in the section instead of the collection objects
     themselves (confirmed empirically), unlike every other endpoint in this file. */
  const perSection = await Promise.all(
    card._config.sections.map(async (s) => {
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/collections`);
        return (data?.MediaContainer?.Metadata || []).map((d) => ({ ...d, section: s }));
      } catch (e) {
        return [];
      }
    })
  );
  return perSection.flat();
}

/* Fetches actual movie items for a handful of randomly-picked real Plex Collections
   (picked fresh in loadAll each real page load) so they can be mixed in as their own
   titled rows - title = collection name, items = its movies - alongside genre/AI rows.
   Uses the dedicated /library/collections/{ratingKey}/children endpoint, NOT a
   `collection=` filter param against /all - confirmed empirically that the latter does
   NOT filter by the collection at all (it silently matched a single unrelated movie
   instead of the collection's real members). The children endpoint also doesn't respect
   sort/X-Plex-Container-Size query params (tested), but returns items in a sensible
   built-in order (chronological/release order) already, and row-size slicing happens
   client-side in the card's _buildCollectionRows anyway, so no params are needed here. */
async function fetchCollectionRowItems(card, picks) {
  const results = await Promise.all(
    picks.map(async (c) => {
      try {
        const data = await plexFetch(card, `/library/collections/${c.ratingKey}/children`);
        return { title: c.title, items: data?.MediaContainer?.Metadata || [] };
      } catch (e) {
        return { title: c.title, items: [] };
      }
    })
  );
  return results.filter((r) => r.items.length);
}

async function fetchPlaylistsRaw(card) {
  /* Server-wide endpoint, not per-section like collections - a playlist can span
     multiple libraries. Posters live under `composite`, not `thumb` (confirmed via raw
     JSON, unlike every other item type in this file). Filtered to playlistType "video"
     since this dashboard has no audio/music sections configured. */
  try {
    const data = await plexFetch(card, "/playlists");
    return (data?.MediaContainer?.Metadata || []).filter((p) => p.playlistType === "video");
  } catch (e) {
    return [];
  }
}

async function loadSearchFacets(card) {
  const studios = [];
  const collections = [];
  await Promise.all(
    card._config.sections.map(async (s) => {
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/studio`, { type: s.type });
        for (const d of data?.MediaContainer?.Directory || []) {
          studios.push({ title: d.title, key: d.key, section: s });
        }
      } catch (e) {}
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/collection`, { type: s.type });
        for (const d of data?.MediaContainer?.Directory || []) {
          collections.push({ title: d.title, key: d.key, section: s });
        }
      } catch (e) {}
    })
  );
  return { studios, collections };
}

async function loadGenreDataBySection(card) {
  const sections = card._config.sections;
  const rowSize = card._config.row_size;
  const result = new Map();

  await Promise.all(
    sections.map(async (s) => {
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/genre`, { type: s.type });
        const genres = data?.MediaContainer?.Directory || [];
        const perGenre = await Promise.all(
          genres.map(async (g) => {
            try {
              const gdata = await plexFetch(card, `/library/sections/${s.key}/all`, {
                type: s.type,
                genre: g.key,
                sort: "addedAt:desc",
                "X-Plex-Container-Size": rowSize,
              });
              const mc = gdata?.MediaContainer || {};
              return { title: g.title, key: g.key, items: mc.Metadata || [], totalSize: mc.totalSize ?? mc.size ?? 0 };
            } catch (e) {
              return { title: g.title, key: g.key, items: [], totalSize: 0 };
            }
          })
        );
        result.set(s.key, perGenre);
      } catch (e) {
        result.set(s.key, []);
      }
    })
  );

  return result;
}

async function loadAiIdeas(card) {
  const key = card._config.openrouter_api_key;
  if (!key) return [];
  const cacheKey = "prism.aiIdeasCache";
  const cadenceMs = card._config.ai_rows_cadence_ms;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
  } catch (e) {
    cached = null;
  }
  if (cached && Array.isArray(cached.ideas) && Date.now() - cached.fetchedAt < cadenceMs) {
    return cached.ideas;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct",
        messages: [
          {
            role: "user",
            content:
              "Generate a JSON array of exactly 10 objects. Each object must have a label field (a short catchy row title, 2 to 5 words) and a genres field (an array of 1 or 2 genre words drawn only from this list: Action, Adventure, Animation, Anime, Biography, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Musical, Mystery, Romance, Sci-Fi, Sport, Suspense, Thriller, War, Western). About half the ideas should combine two different genres for interesting mixes, for example Sci-Fi Comedy would have genres Sci-Fi and Comedy. Respond with ONLY the raw JSON array. No markdown code fences. No explanation. No extra text before or after the array.",
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
    const data = await res.json();
    const ideas = parseAiSectionIdeas(data?.choices?.[0]?.message?.content);
    if (ideas.length) localStorage.setItem(cacheKey, JSON.stringify({ ideas, fetchedAt: Date.now() }));
    return ideas;
  } catch (e) {
    return (cached && cached.ideas) || [];
  }
}

async function fetchAiRowsRaw(card, ideas) {
  const rowSize = card._config.row_size;
  const results = await Promise.all(
    ideas.map(async (idea) => {
      const perSection = await Promise.all(
        card._config.sections.map(async (s) => {
          const genreEntries = (card._genreBySection && card._genreBySection.get(s.key)) || [];
          const keys = idea.genres.map((g) => {
            const norm = g.trim().toLowerCase();
            const match = genreEntries.find((e) => e.title.trim().toLowerCase() === norm);
            return match ? match.key : null;
          });
          if (keys.some((k) => !k)) return [];
          try {
            const data = await plexFetch(card, `/library/sections/${s.key}/all`, {
              type: s.type,
              genre: keys,
              sort: "addedAt:desc",
              "X-Plex-Container-Size": rowSize,
            });
            return data?.MediaContainer?.Metadata || [];
          } catch (e) {
            return [];
          }
        })
      );
      return { label: idea.label, genres: idea.genres, items: perSection.flat() };
    })
  );
  return results.filter((r) => r.items.length);
}

export async function loadAll(card) {
  if (!card._config.plex_url || !card._config.plex_token) {
    card._renderMessage("Open Settings to add your Plex server URL and token.");
    return;
  }
  if (!card._config.sections || !card._config.sections.length) {
    card._renderMessage('Open Settings and click "Fetch Libraries" to choose what to show.');
    return;
  }
  card._renderLoading();
  try {
    const reachable = await StreamingPlexAuth.ensureReachable(card._config);
    if (reachable.plex_url !== card._config.plex_url || reachable.plex_token !== card._config.plex_token) {
      card._config.plex_url = reachable.plex_url;
      card._config.plex_token = reachable.plex_token;
      savePlain({ ...loadPlain(), plex_url: reachable.plex_url });
      const secrets = hasSecrets() ? await loadSecrets() : {};
      await saveSecrets({ ...secrets, plex_token: reachable.plex_token });
    }
  } catch (e) {
    card._renderMessage(`Couldn't reach your Plex server: ${e.message}`);
    return;
  }
  /* First paint is gated on only the cheap, no-fan-out fetches (on deck/watchlist/
     recently added) - the hero's initial item now picks from that same pool (see
     _buildHeroInitialPool/pickHeroItemFromPool) instead of the full per-genre fan-out (N
     sections x M genres), which was otherwise the single most expensive thing on the
     critical path. Genre rows, search facets, watch history, collections, playlists,
     home profiles, and especially the OpenRouter AI-rows call all load in the background
     afterward (see loadBackgroundData below), streamed in via extra _renderCurrentView()
     passes instead of blocking the very first render. */
  try {
    const [onDeckRaw, watchlistRaw, recentlyAddedRaw] = await Promise.all([
      fetchOnDeckRaw(card),
      fetchWatchlistRaw(card),
      fetchRecentlyAddedRaw(card),
    ]);
    card._onDeckRaw = onDeckRaw;
    card._watchlistRaw = watchlistRaw;
    card._recentlyAddedRaw = recentlyAddedRaw;
    card._genreRowsCache = {};
    card._recommendedRowCache = {};
    const view = card._currentView || "home";
    await card._hero.loadInitialItem(card._buildHeroInitialPool(view));
    /* The user can start typing into search well before this first paint (and the
       background load below) resolve - card._currentView flips to "search" and its own
       render pipeline (search-page.js) owns _rowsEl from then on. Without this check,
       this unconditional re-render stomps the search results back to the home/section
       grid while _currentView still says "search", leaving nav/search state and what's
       on screen out of sync until the next explicit exitSearch(). The underlying data
       this assigns above is still picked up correctly whenever the user does back out of
       search, since exitSearch() itself calls _renderCurrentView(). */
    if (card._currentView !== "search") card._renderCurrentView();
  } catch (err) {
    card._renderMessage(`Couldn't load Plex: ${err.message}`);
    return;
  }

  card._showLoadingMore();
  loadBackgroundData(card)
    .catch((err) => console.warn("[data] background load failed:", err))
    .finally(() => card._hideLoadingMore());
}

/* Everything _renderCurrentView() can do without: genre/AI/collection rows, "Recommended"/
   "Popular", the profile switcher, and search facets. Runs after the first paint (see
   loadAll above) and re-renders in two more passes as each chunk lands, rather than making
   the user stare at a spinner for however long the slowest of these (usually the AI-rows
   OpenRouter call) takes. Re-renders pass { showHero: false } so streaming rows in doesn't
   repeatedly reset hero mute state / restart its trailer - see _renderCurrentView. */
async function loadBackgroundData(card) {
  const [genreBySection, searchFacets, historyRaw, collectionsRaw, playlistsRaw, homeProfiles] = await Promise.all([
    loadGenreDataBySection(card),
    loadSearchFacets(card),
    fetchWatchHistoryRaw(card),
    fetchCollectionsRaw(card),
    fetchPlaylistsRaw(card),
    card._fetchHomeProfiles(),
  ]);
  card._genreBySection = genreBySection;
  card._studioFacets = searchFacets.studios;
  card._collectionFacets = searchFacets.collections;
  card._collectionsRaw = collectionsRaw;
  card._playlistsRaw = playlistsRaw;
  card._homeUsers = homeProfiles.users;
  card._activeUserId = homeProfiles.activeId;
  card._renderProfileNav();
  const rowCount = card._config.collection_row_count ?? 0;
  card._collectionRowPicks = card._shuffle(card._collectionsRaw).slice(0, rowCount);
  card._collectionRowsRaw = await fetchCollectionRowItems(card, card._collectionRowPicks);
  card._recommendedRaw = card._buildRecommendedRaw(historyRaw);
  card._popularRaw = card._buildPopularRaw();
  card._genreRowsCache = {};
  card._recommendedRowCache = {};
  await card._hero.fillFromGenresIfStillEmpty(sectionsForView(card, card._currentView));
  /* Same "don't stomp an active search view" guard as loadAll above - the user may well
     still be searching by the time this background load (or the AI-rows pass after it)
     resolves. */
  if (card._currentView !== "search") card._renderCurrentView({ showHero: false });

  const aiIdeas = await loadAiIdeas(card);
  card._aiRowsRaw = aiIdeas.length ? await fetchAiRowsRaw(card, aiIdeas) : [];
  card._genreRowsCache = {};
  if (card._currentView !== "search") card._renderCurrentView({ showHero: false });
}
