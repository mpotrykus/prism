import { describe, it, expect } from "vitest";
import { slugify, isAndroidUserAgent, tapUrl } from "./deep-link.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("The Matrix: Reloaded")).toBe("the-matrix-reloaded");
  });
  it("strips leading/trailing hyphens", () => {
    expect(slugify("!!!Attack!!!")).toBe("attack");
  });
  it("falls back to 'item' for empty input", () => {
    expect(slugify("")).toBe("item");
    expect(slugify(null)).toBe("item");
  });
});

describe("isAndroidUserAgent", () => {
  it("matches an Android UA", () => {
    expect(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 14)")).toBe(true);
  });
  it("doesn't match a desktop UA", () => {
    expect(isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });
});

const ctx = { machineId: "abc123", plexUrl: "http://192.168.1.5:32400", userAgent: "" };
const androidCtx = { ...ctx, userAgent: "Mozilla/5.0 (Linux; Android 14)" };

describe("tapUrl", () => {
  it("prefers the Discover deep link for watchlist items", () => {
    const url = tapUrl({ key: "/library/metadata/999", type: "movie", ratingKey: "999" }, "watchlist", ctx);
    expect(url).toContain("app.plex.tv/desktop/#!/provider/tv.plex.provider.discover/details");
  });

  it("builds a plex:// movie deep link on Android", () => {
    const url = tapUrl({ type: "movie", ratingKey: "1", title: "Dune" }, undefined, androidCtx);
    expect(url).toBe("plex://libraries/abc123/movie/dune/1");
  });

  it("builds a plex:// episode deep link on Android", () => {
    const item = {
      type: "episode",
      ratingKey: "10",
      title: "Pilot",
      showKey: "5",
      seasonKey: "6",
      seasonNumber: 1,
      episodeNumber: 1,
    };
    const url = tapUrl(item, undefined, androidCtx);
    expect(url).toBe("plex://libraries/abc123/show/pilot/5/s/1/6/e/1/10");
  });

  it("falls back to a web details link off Android", () => {
    const url = tapUrl({ type: "movie", ratingKey: "1", title: "Dune" }, undefined, ctx);
    expect(url).toBe(`http://192.168.1.5:32400/web/index.html#!/server/abc123/details?key=${encodeURIComponent("/library/metadata/1")}`);
  });

  it("builds a web collection link off Android", () => {
    const url = tapUrl({ type: "collection", ratingKey: "7" }, undefined, ctx);
    expect(url).toBe(`http://192.168.1.5:32400/web/index.html#!/server/abc123/details?key=${encodeURIComponent("/library/collections/7")}`);
  });
});
