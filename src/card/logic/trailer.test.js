import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTrailerVideo } from "./trailer.js";
import * as tmdb from "./tmdb.js";
import * as youtubeOembed from "./youtube-oembed.js";

vi.mock("./tmdb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveTmdbTrailer: vi.fn(), resolveTmdbIdFromImdb: vi.fn() };
});

vi.mock("./youtube-oembed.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getYoutubeAspectRatio: vi.fn() };
});

describe("resolveTrailerVideo", () => {
  const config = { plex_url: "http://srv", plex_token: "tok" };

  beforeEach(() => {
    tmdb.resolveTmdbTrailer.mockReset();
    tmdb.resolveTmdbIdFromImdb.mockReset();
    // Default to "unknown ratio" (null) so existing assertions that don't care about
    // coverScale keep working - it just resolves to the neutral 1x in that case.
    youtubeOembed.getYoutubeAspectRatio.mockReset().mockResolvedValue(null);
  });

  it("returns a Plex-hosted trailer when one exists as an extra, without touching TMDB", async () => {
    const plexFetch = vi.fn().mockResolvedValue({
      MediaContainer: { Metadata: [{ subtype: "trailer", Media: [{ Part: [{ key: "/trailer.mp4" }] }] }] },
    });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video).toEqual({ type: "plex", url: "http://srv/trailer.mp4?X-Plex-Token=tok" });
    expect(plexFetch).toHaveBeenCalledTimes(1);
    expect(tmdb.resolveTmdbTrailer).not.toHaveBeenCalled();
  });

  it("returns null without any TMDB lookup when the fallback is disabled", async () => {
    const plexFetch = vi.fn().mockResolvedValue({ MediaContainer: { Metadata: [] } });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: false });
    expect(video).toBeNull();
    expect(tmdb.resolveTmdbTrailer).not.toHaveBeenCalled();
  });

  it("falls back to a TMDB-discovered trailer for a movie when Plex has none", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://550" }] }] } });
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "abc123", name: "Trailer", official: true });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.type).toBe("youtube");
    expect(video.embedUrl).toContain("abc123");
    expect(tmdb.resolveTmdbTrailer).toHaveBeenCalledWith("550", "movie");
    expect(plexFetch).toHaveBeenNthCalledWith(2, "/library/metadata/1");
  });

  it("resolves an episode's trailer via its parent show's tmdb id", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://1399" }] }] } });
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "xyz789", name: "Trailer", official: false });
    const item = { ratingKey: "99", type: "episode", showKey: "5" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.embedUrl).toContain("xyz789");
    expect(plexFetch).toHaveBeenNthCalledWith(2, "/library/metadata/5");
    expect(tmdb.resolveTmdbTrailer).toHaveBeenCalledWith("1399", "tv");
  });

  it("returns null when Plex has no trailer and the item has no tmdb guid at all", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ Guid: [{ id: "imdb://tt123" }] }] } });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video).toBeNull();
    expect(tmdb.resolveTmdbTrailer).not.toHaveBeenCalled();
  });

  it("skips TMDB entirely for item types with no trailer mapping (e.g. a season)", async () => {
    const plexFetch = vi.fn().mockResolvedValueOnce({ MediaContainer: { Metadata: [] } });
    const item = { ratingKey: "1", type: "season" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video).toBeNull();
    expect(plexFetch).toHaveBeenCalledTimes(1);
  });

  /* Regression test for a real library found scanned with Plex's legacy IMDb agent -
     no `Guid` array at all, just an opaque `guid` string. */
  it("resolves via a legacy IMDb-agent guid when there's no new-agent Guid array", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ guid: "com.plexapp.agents.imdb://tt0238380?lang=en" }] } });
    tmdb.resolveTmdbIdFromImdb.mockResolvedValue("550");
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "legacy123", name: "Trailer", official: true });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.embedUrl).toContain("legacy123");
    expect(tmdb.resolveTmdbIdFromImdb).toHaveBeenCalledWith("tt0238380", "movie");
    expect(tmdb.resolveTmdbTrailer).toHaveBeenCalledWith("550", "movie");
  });

  it("resolves via a legacy TMDB-agent guid directly, without an imdb translation step", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ guid: "com.plexapp.agents.themoviedb://550?lang=en" }] } });
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "direct123", name: "Trailer", official: true });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.embedUrl).toContain("direct123");
    expect(tmdb.resolveTmdbIdFromImdb).not.toHaveBeenCalled();
    expect(tmdb.resolveTmdbTrailer).toHaveBeenCalledWith("550", "movie");
  });

  it("defaults coverScale to 1 when the video's aspect ratio can't be determined", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://550" }] }] } });
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "abc123", name: "Trailer", official: true });
    const item = { ratingKey: "1", type: "movie" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.coverScale).toBe(1);
  });

  /* Regression test for the real Trigun trailer: TMDB's only listed video for it is a
     360p, non-official upload of natively-4:3 footage - YouTube's own player pillarboxes
     that inside a 16:9 iframe unless corrected (see youtube-oembed.js). */
  it("computes a corrective coverScale for a non-16:9 trailer", async () => {
    const plexFetch = vi
      .fn()
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://26453" }] }] } });
    tmdb.resolveTmdbTrailer.mockResolvedValue({ youtubeId: "mVuJ5AlaZdg", name: "Trigun trailer", official: false });
    youtubeOembed.getYoutubeAspectRatio.mockResolvedValue(4 / 3);
    const item = { ratingKey: "1", type: "show" };
    const video = await resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled: true });
    expect(video.coverScale).toBeCloseTo((16 / 9) / (4 / 3), 5);
    expect(youtubeOembed.getYoutubeAspectRatio).toHaveBeenCalledWith("mVuJ5AlaZdg");
  });
});
