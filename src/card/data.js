import { parseAiSectionIdeas } from "./logic/catalog.js";
import * as StreamingPlexAuth from "../../plex-auth.js";
import { loadPlain, savePlain } from "../../settings.js";
import { hasSecrets, loadSecrets, saveSecrets } from "../../vault.js";

/* Plex fetch/data-loading orchestration - the card's single "go get everything Home
   needs" entry point plus every raw fetch it fans out to. Takes the PlexNetflixCard
   instance as an explicit first argument (same pattern plex-player.js's native-bridge.js/
   web-fallback.js use) since these all read this._config and write the handful of
   `_xRaw`/`_xBySection` fields the row-building logic (logic/catalog.js) consumes. */

/* The server the app fell back to before multi-server support existed, and still the
   fallback for anything that can't resolve a more specific one (a section saved before
   this app tracked server_id, an item with no __server tag, etc.) - mirrors whichever
   discovered server has owned:true, falling back further to the flat plex_url/plex_token/
   machine_id fields for a config saved before `servers` existed at all. */
export function primaryServer(card) {
  const owned = (card._config.servers || []).find((s) => s.owned);
  if (owned) return owned;
  return { id: card._config.machine_id, url: card._config.plex_url, token: card._config.plex_token, name: "", owned: true };
}

export function serverById(card, id) {
  return (card._config.servers || []).find((s) => s.id === id) || null;
}

export function serverForSection(card, section) {
  return (section?.server_id && serverById(card, section.server_id)) || primaryServer(card);
}

/* A server contributes to Home/on-deck/history/playlists once the user has turned
   anything on for it - its own "All" toggle, or at least one individual library. A
   freshly-discovered, still-untouched server contributes nothing (though per the
   default-on behavior in settings.js, that's a transient state, not the normal case). */
export function activeServers(card) {
  const servers = card._config.servers || [];
  const sections = card._config.sections || [];
  return servers.filter((sv) => sv.all_enabled || sections.some((s) => s.server_id === sv.id && s.enabled !== false));
}

export async function plexFetch(card, path, params = {}, server = null) {
  const s = server || primaryServer(card);
  const url = new URL(s.url + path);
  Object.entries(params).forEach(([k, v]) => {
    /* Plex ANDs repeated same-key filter params (e.g. two `genre=` keys) rather than
       ORing them - array values let AI-generated multi-genre rows use that. */
    if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, vv));
    else url.searchParams.set(k, v);
  });
  url.searchParams.set("X-Plex-Token", s.token);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Plex ${path} -> HTTP ${res.status}`);
  /* Action endpoints like /:/scrobble and /:/unscrobble respond 200 with an empty body,
     not JSON - res.json() throws on that (SyntaxError: Unexpected end of JSON input),
     which every caller's catch block then swallows as if the action itself had failed
     even though Plex already applied it server-side. */
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  /* Stamp every raw item this call returns with the server it came from - the one place
     this needs to happen for the whole app to know "which server" a given item is from,
     rather than every call site remembering to tag its own results. catalog.js's mapItem
     reads this (as __server) to resolve per-item image/art URLs and to attach `server`
     to the mapped item, which playback/deep-link/scrobble code then reads directly. */
  const mc = data?.MediaContainer;
  if (mc) {
    (mc.Metadata || []).forEach((m) => { m.__server = s; });
    (mc.Directory || []).forEach((d) => { d.__server = s; });
    /* Hub-shaped endpoints (/library/metadata/<id>/related, /hubs/search, ...) nest
       their items under Hub[].Metadata instead of a top-level Metadata array - missing
       this left every item from those endpoints with no __server, silently falling back
       to the primary server for its image/thumb URLs (and, if ever played, for playback
       itself) whenever the fetch was actually against a different (e.g. shared) server. */
    (mc.Hub || []).forEach((h) => (h.Metadata || []).forEach((m) => { m.__server = s; }));
  }
  return data;
}

/* "home"/"server-<id>"/"search" (or any unrecognized view) fall through to null, meaning
   "no single section" - callers treat that as "some set of sections", see
   sectionsForView. */
export function sectionForView(card, view) {
  if (typeof view !== "string" || !view.startsWith("section-")) return null;
  /* Plex library keys are small integers assigned per-server (1, 2, 3...), NOT globally
     unique - two servers' first movie library are both very likely "key 1". The view id
     (see nav.js's buildNavTabs) is `section-<server_id>:<key>` for exactly this reason -
     matching on key alone here previously always resolved to whichever server's section
     happened to come first in card._config.sections, silently fetching/showing that
     server's library contents under the other server's tab. */
  const raw = view.slice("section-".length);
  const sep = raw.indexOf(":");
  const server_id = raw.slice(0, sep);
  const key = Number(raw.slice(sep + 1));
  return (card._config.sections || []).find((s) => s.server_id === server_id && s.key === key) || null;
}

export function sectionsForView(card, view) {
  const section = sectionForView(card, view);
  if (section) return [section];
  if (typeof view === "string" && view.startsWith("server-")) {
    const id = view.slice("server-".length);
    return (card._config.sections || []).filter((s) => s.server_id === id && s.enabled !== false);
  }
  /* Home/"everything" - explicit enabled filter rather than trusting
     card._config.sections to already be enabled-only (true today only because
     settings.js's save strips disabled sections out of what it persists - an implicit
     invariant this makes explicit instead of relying on). */
  return (card._config.sections || []).filter((s) => s.enabled !== false);
}

/* Tags a raw item with the exact section it was fetched from (server_id+key) - stamped
   at every per-section fetch below (recentlyAdded/genre-by-section/AI rows) so later
   per-library-tab filtering (plex-netflix-card.js's _serverFilterForView) can match
   against this instead of trusting Plex's own librarySectionID field on the item, which
   real-world testing against a multi-library server showed was NOT reliably present/
   correct on every endpoint this app calls - genre rows (mergeGenreRows, keyed off this
   same server_id+key at the Map level rather than a per-item field) never had this bug,
   which is what exposed it: every OTHER row (Recently Added/Recommended/Popular/AI),
   built by flattening several sections' items together and filtering by librarySectionID
   afterward, kept mixing sections of the same type on the same server even after that
   filter was added. m.__section here is the authoritative fix - it's set from the exact
   section object this fetch was made for, no trust in Plex's response shape required. */
function stampSection(m, s) {
  m.__section = { server_id: s.server_id, key: s.key };
}

/* /library/onDeck is server-wide (not fetched per-section, so stampSection above doesn't
   apply here) - it returns in-progress items from every library on that server,
   including ones the user has unchecked in this app's Settings (unchecking a library
   only drops it from card._config.sections, a client-side "which libraries does this app
   show" list - Plex itself has no concept of that toggle). This is the one place this
   app still has to trust Plex's own librarySectionID field on each item, for lack of any
   fetch-time section context to stamp instead - filtered against the same enabled-
   sections list genre/collection rows already use, keyed the same server_id+key way as
   everything else here (see sectionForView's own comment on why key alone isn't safe) -
   m.__server is the server this item's own fetch was tagged with (plexFetch), not
   necessarily the primary server. Items with no librarySectionID (unexpected, but Plex
   response shapes drift) are kept rather than dropped, so a field-name mismatch fails
   open instead of silently emptying the whole row. */
function isFromEnabledSection(card, m) {
  if (m.librarySectionID == null) return true;
  const sid = m.__server?.id;
  return (card._config.sections || []).some(
    (s) => s.enabled !== false && s.server_id === sid && s.key === Number(m.librarySectionID)
  );
}

export async function fetchOnDeckRaw(card) {
  const perServer = await Promise.all(
    activeServers(card).map(async (sv) => {
      try {
        const data = await plexFetch(card, "/library/onDeck", {}, sv);
        return data?.MediaContainer?.Metadata || [];
      } catch (e) {
        return [];
      }
    })
  );
  return perServer.flat().filter((m) => isFromEnabledSection(card, m));
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
  const perServer = await Promise.all(
    activeServers(card).map(async (sv) => {
      try {
        const data = await plexFetch(
          card,
          "/status/sessions/history/all",
          { sort: "viewedAt:desc", "X-Plex-Container-Size": 500 },
          sv
        );
        return data?.MediaContainer?.Metadata || [];
      } catch (e) {
        return [];
      }
    })
  );
  return perServer.flat();
}

async function fetchRecentlyAddedRaw(card) {
  const rowSize = card._config.row_size;
  const perSection = await Promise.all(
    card._config.sections.map(async (s) => {
      try {
        const data = await plexFetch(
          card,
          `/library/sections/${s.key}/all`,
          { type: s.type, sort: "addedAt:desc", "X-Plex-Container-Size": rowSize },
          serverForSection(card, s)
        );
        const items = data?.MediaContainer?.Metadata || [];
        /* Stamp with the section this was actually queried against, same idea as
           plexFetch's own __server stamp - see stampSection's own comment for why this
           is authoritative where trusting Plex's own librarySectionID field on each item
           was not. */
        items.forEach((m) => stampSection(m, s));
        return items;
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
        const data = await plexFetch(card, `/library/sections/${s.key}/collections`, {}, serverForSection(card, s));
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
        const data = await plexFetch(
          card,
          `/library/collections/${c.ratingKey}/children`,
          {},
          serverForSection(card, c.section)
        );
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
     since this dashboard has no audio/music sections configured. Fetched per active
     server (see fetchOnDeckRaw above) rather than once - a playlist can't span servers,
     so a playlist row is inherently scoped to whichever server it lives on. */
  const perServer = await Promise.all(
    activeServers(card).map(async (sv) => {
      try {
        const data = await plexFetch(card, "/playlists", {}, sv);
        return (data?.MediaContainer?.Metadata || []).filter((p) => p.playlistType === "video");
      } catch (e) {
        return [];
      }
    })
  );
  return perServer.flat();
}

async function loadSearchFacets(card) {
  const studios = [];
  const collections = [];
  await Promise.all(
    card._config.sections.map(async (s) => {
      const server = serverForSection(card, s);
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/studio`, { type: s.type }, server);
        for (const d of data?.MediaContainer?.Directory || []) {
          studios.push({ title: d.title, key: d.key, section: s });
        }
      } catch (e) {}
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/collection`, { type: s.type }, server);
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
      const server = serverForSection(card, s);
      try {
        const data = await plexFetch(card, `/library/sections/${s.key}/genre`, { type: s.type }, server);
        const genres = data?.MediaContainer?.Directory || [];
        const perGenre = await Promise.all(
          genres.map(async (g) => {
            try {
              const gdata = await plexFetch(
                card,
                `/library/sections/${s.key}/all`,
                { type: s.type, genre: g.key, sort: "addedAt:desc", "X-Plex-Container-Size": rowSize },
                server
              );
              const mc = gdata?.MediaContainer || {};
              const items = mc.Metadata || [];
              /* This per-section/per-genre pool also backs buildRecommendedRaw/
                 buildPopularRaw (catalog.js), which flatten items across every section
                 into one deduped-by-ratingKey pool - stamping here is what lets
                 plex-netflix-card.js's _serverFilterForView scope those two rows back
                 down to a single library tab afterward (see stampSection's own comment). */
              items.forEach((m) => stampSection(m, s));
              return { title: g.title, key: g.key, items, totalSize: mc.totalSize ?? mc.size ?? 0 };
            } catch (e) {
              return { title: g.title, key: g.key, items: [], totalSize: 0 };
            }
          })
        );
        /* Keyed by server_id+key, not key alone - Plex library keys are small per-server
           integers (1, 2, 3...), not globally unique, so two servers' first library would
           otherwise collide in this Map and silently overwrite each other's genre data
           (same convention settings.js's own section merge already uses). */
        result.set(`${s.server_id}:${s.key}`, perGenre);
      } catch (e) {
        result.set(`${s.server_id}:${s.key}`, []);
      }
    })
  );

  return result;
}

async function loadAiIdeas(card) {
  const key = card._config.openrouter_api_key;
  if (!card._config.ai_rows_enabled || !key) return [];
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
          const genreEntries = (card._genreBySection && card._genreBySection.get(`${s.server_id}:${s.key}`)) || [];
          const keys = idea.genres.map((g) => {
            const norm = g.trim().toLowerCase();
            const match = genreEntries.find((e) => e.title.trim().toLowerCase() === norm);
            return match ? match.key : null;
          });
          if (keys.some((k) => !k)) return [];
          try {
            const data = await plexFetch(
              card,
              `/library/sections/${s.key}/all`,
              { type: s.type, genre: keys, sort: "addedAt:desc", "X-Plex-Container-Size": rowSize },
              serverForSection(card, s)
            );
            const items = data?.MediaContainer?.Metadata || [];
            items.forEach((m) => stampSection(m, s));
            return items;
          } catch (e) {
            return [];
          }
        })
      );
      /* Same hit-the-cap heuristic as fetchRecentlyAddedRaw above - this per-section
         query has no totalSize to check precisely either. */
      return {
        label: idea.label,
        genres: idea.genres,
        items: perSection.flat(),
        hasMore: perSection.some((items) => items.length >= rowSize),
      };
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
    /* Re-probes every known server the same way the old single-server version probed
       the one - a stale cached URL doesn't fail fast off-LAN (see ensureReachable's own
       comment), so this has to run before any of the per-server fetches below. Only the
       owned server being unreachable is fatal (throws out to the catch, same failure
       mode as before this app knew about more than one server) - a friend's server
       failing to resolve here just leaves its stored url/token as-is, and every
       per-server fetch elsewhere already tolerates that failing gracefully (empty
       results, not a thrown error the user sees). */
    const servers = card._config.servers?.length ? card._config.servers : [primaryServer(card)];
    await Promise.all(
      servers.map(async (sv) => {
        try {
          const r = await StreamingPlexAuth.ensureReachable({
            plex_url: sv.url,
            plex_token: sv.token,
            plex_account_token: card._config.plex_account_token,
            machine_id: sv.id,
          });
          sv.url = r.plex_url;
          sv.token = r.plex_token;
        } catch (e) {
          if (sv.owned) throw e;
        }
      })
    );
    if (card._config.servers?.length) {
      const plain = loadPlain();
      plain.servers = card._config.servers.map(({ token, ...rest }) => rest);
      savePlain(plain);
      const secrets = hasSecrets() ? await loadSecrets() : {};
      secrets.server_tokens = Object.fromEntries(card._config.servers.map((sv) => [sv.id, sv.token]));
      await saveSecrets(secrets);
    } else {
      const [primary] = servers;
      card._config.plex_url = primary.url;
      card._config.plex_token = primary.token;
      savePlain({ ...loadPlain(), plex_url: primary.url });
      const secrets = hasSecrets() ? await loadSecrets() : {};
      await saveSecrets({ ...secrets, plex_token: primary.token });
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
