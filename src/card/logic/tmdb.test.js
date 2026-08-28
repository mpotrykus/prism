import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractTmdbId, extractLegacyAgentId, pickBestTrailer, resolveTmdbTrailer, resolveTmdbIdFromImdb } from "./tmdb.js";

describe("extractTmdbId", () => {
  it("finds the tmdb:// guid among others", () => {
    expect(extractTmdbId([{ id: "imdb://tt123" }, { id: "tmdb://550" }, { id: "tvdb://1" }])).toBe("550");
  });

  it("returns null when no tmdb guid is present", () => {
    expect(extractTmdbId([{ id: "imdb://tt123" }])).toBeNull();
  });

  it("returns null for missing/empty input", () => {
    expect(extractTmdbId(undefined)).toBeNull();
    expect(extractTmdbId([])).toBeNull();
  });
});

describe("extractLegacyAgentId", () => {
  it("parses a legacy TMDB agent guid", () => {
    expect(extractLegacyAgentId("com.plexapp.agents.themoviedb://550?lang=en")).toEqual({ source: "tmdb", id: "550" });
  });

  it("parses a legacy IMDb agent guid", () => {
    expect(extractLegacyAgentId("com.plexapp.agents.imdb://tt0238380?lang=en")).toEqual({ source: "imdb", id: "tt0238380" });
  });

  it("returns null for a new-agent guid or anything else unrecognized", () => {
    expect(extractLegacyAgentId("plex://movie/5d776b59ad5437001f79c6f8")).toBeNull();
    expect(extractLegacyAgentId(null)).toBeNull();
    expect(extractLegacyAgentId("")).toBeNull();
  });
});

describe("pickBestTrailer", () => {
  it("returns null when there are no videos", () => {
    expect(pickBestTrailer([])).toBeNull();
    expect(pickBestTrailer(undefined)).toBeNull();
  });

  it("ignores non-YouTube and non-Trailer entries", () => {
    const videos = [
      { site: "Vimeo", type: "Trailer", key: "v1", official: true },
      { site: "YouTube", type: "Teaser", key: "v2", official: true },
      { site: "YouTube", type: "Clip", key: "v3", official: true },
    ];
    expect(pickBestTrailer(videos)).toBeNull();
  });

  it("prefers an official trailer over a non-official one", () => {
    const videos = [
      { site: "YouTube", type: "Trailer", key: "unofficial", official: false, published_at: "2020-01-01" },
      { site: "YouTube", type: "Trailer", key: "official", official: true, published_at: "2019-01-01" },
    ];
    expect(pickBestTrailer(videos)?.youtubeId).toBe("official");
  });

  it("falls back to a non-official trailer when no official one exists", () => {
    const videos = [{ site: "YouTube", type: "Trailer", key: "only-one", official: false }];
    expect(pickBestTrailer(videos)?.youtubeId).toBe("only-one");
  });

  it("prefers English among equally-official candidates", () => {
    const videos = [
      { site: "YouTube", type: "Trailer", key: "fr", official: true, iso_639_1: "fr", published_at: "2020-06-01" },
      { site: "YouTube", type: "Trailer", key: "en", official: true, iso_639_1: "en", published_at: "2019-01-01" },
    ];
    expect(pickBestTrailer(videos)?.youtubeId).toBe("en");
  });

  it("prefers the most recently published among equally-official, equally-language candidates", () => {
    const videos = [
      { site: "YouTube", type: "Trailer", key: "older", official: true, iso_639_1: "en", published_at: "2019-01-01" },
      { site: "YouTube", type: "Trailer", key: "newer", official: true, iso_639_1: "en", published_at: "2021-01-01" },
    ];
    expect(pickBestTrailer(videos)?.youtubeId).toBe("newer");
  });
});

/* .env.test (tracked, fake key - see .gitignore's comment on it) makes VITE_TMDB_API_KEY
   deterministically truthy for every test run, regardless of whatever real .env a given
   machine also has - so these exercise the real fetch path against a mocked global.fetch
   rather than depending on local machine state. */
describe("resolveTmdbTrailer", () => {
  const originalFetch = global.fetch;
  const originalLocalStorage = global.localStorage;
  let store;

  beforeEach(() => {
    store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    };
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalLocalStorage;
  });

  it("returns the cached trailer without calling fetch when a fresh entry exists", async () => {
    store["prism.trailerCache"] = JSON.stringify({
      "movie:550": { value: { youtubeId: "cached123", name: "x", official: true }, fetchedAt: Date.now() },
    });
    const result = await resolveTmdbTrailer("550", "movie");
    expect(result).toEqual({ youtubeId: "cached123", name: "x", official: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns null and never calls fetch when no tmdbId/kind is given", async () => {
    expect(await resolveTmdbTrailer(null, "movie")).toBeNull();
    expect(await resolveTmdbTrailer("550", null)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches from TMDB on a cache miss, picks the best trailer, and caches it", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        videos: { results: [{ site: "YouTube", type: "Trailer", key: "abc123", official: true, iso_639_1: "en" }] },
      }),
    });
    const result = await resolveTmdbTrailer("601", "movie");
    expect(result).toEqual({ youtubeId: "abc123", name: "", official: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0].toString();
    expect(url).toContain("/movie/601");
    expect(url).toContain("append_to_response=videos");
    // A second call should now be served from cache rather than fetching again.
    await resolveTmdbTrailer("601", "movie");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null without throwing when TMDB responds with an error status", async () => {
    global.fetch.mockResolvedValue({ ok: false });
    expect(await resolveTmdbTrailer("999", "movie")).toBeNull();
  });
});

describe("resolveTmdbIdFromImdb", () => {
  const originalFetch = global.fetch;
  const originalLocalStorage = global.localStorage;
  let store;

  beforeEach(() => {
    store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    };
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalLocalStorage;
  });

  it("translates an imdb id to a tmdb movie id via TMDB's find endpoint", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ movie_results: [{ id: 550 }], tv_results: [] }),
    });
    const result = await resolveTmdbIdFromImdb("tt0137523", "movie");
    expect(result).toBe("550");
    const url = global.fetch.mock.calls[0][0].toString();
    expect(url).toContain("/find/tt0137523");
    expect(url).toContain("external_source=imdb_id");
  });

  it("returns null and caches the miss when TMDB has no match", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ movie_results: [], tv_results: [] }) });
    expect(await resolveTmdbIdFromImdb("tt0000000", "movie")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Cached miss - a second lookup shouldn't hit fetch again.
    expect(await resolveTmdbIdFromImdb("tt0000000", "movie")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
