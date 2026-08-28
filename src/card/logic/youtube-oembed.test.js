import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeCoverScale, getYoutubeAspectRatio } from "./youtube-oembed.js";

describe("computeCoverScale", () => {
  it("returns 1 (no-op) for an already-16:9 video", () => {
    expect(computeCoverScale(16 / 9)).toBe(1);
  });

  it("scales up a 4:3 video pillarboxed inside a 16:9 wrap", () => {
    // Matches the real Trigun trailer case: 200x150 oembed dimensions (4:3).
    expect(computeCoverScale(4 / 3)).toBeCloseTo((16 / 9) / (4 / 3), 5);
  });

  it("scales up a cinematic (wider-than-16:9) video letterboxed inside a 16:9 wrap", () => {
    const cinemaRatio = 2.35;
    expect(computeCoverScale(cinemaRatio)).toBeCloseTo(cinemaRatio / (16 / 9), 5);
  });

  it("falls back to 1 for a missing/invalid ratio rather than NaN/Infinity", () => {
    expect(computeCoverScale(null)).toBe(1);
    expect(computeCoverScale(undefined)).toBe(1);
    expect(computeCoverScale(0)).toBe(1);
    expect(computeCoverScale(-1)).toBe(1);
    expect(computeCoverScale(NaN)).toBe(1);
    expect(computeCoverScale(Infinity)).toBe(1);
  });

  it("respects a custom wrapRatio", () => {
    expect(computeCoverScale(4 / 3, 4 / 3)).toBe(1);
  });
});

describe("getYoutubeAspectRatio", () => {
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

  it("returns null and never calls fetch when no videoId is given", async () => {
    expect(await getYoutubeAspectRatio(null)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches from oEmbed, computes the ratio, and caches it", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ width: 200, height: 150 }) });
    const ratio = await getYoutubeAspectRatio("mVuJ5AlaZdg");
    expect(ratio).toBeCloseTo(4 / 3, 5);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0].toString();
    expect(url).toContain("/oembed");
    expect(url).toContain("mVuJ5AlaZdg");
    // Second lookup should be served from cache.
    await getYoutubeAspectRatio("mVuJ5AlaZdg");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null without throwing on a malformed or failed response", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    expect(await getYoutubeAspectRatio("bad1")).toBeNull();
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    expect(await getYoutubeAspectRatio("bad2")).toBeNull();
  });
});
