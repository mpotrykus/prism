import { describe, it, expect } from "vitest";
import { pickHeroItem, pickHeroItemFromPool, formatDuration, heroArtUrl, heroSubtitleText, heroShouldPlay } from "./hero.js";

describe("pickHeroItem", () => {
  const genreBySection = new Map([
    [1, [{ title: "Sci-Fi", items: [{ ratingKey: "1" }, { ratingKey: "2" }] }]],
    [2, [{ title: "Horror", items: [{ ratingKey: "3" }] }]],
  ]);

  it("returns null when the pool is empty", () => {
    expect(pickHeroItem(undefined, undefined, { genreBySection: new Map() })).toBeNull();
  });

  it("restricts to the given sections", () => {
    const pick = pickHeroItem(undefined, [{ key: 2 }], { genreBySection });
    expect(pick.ratingKey).toBe("3");
  });

  it("excludes the given ratingKey when more than one candidate remains", () => {
    for (let i = 0; i < 10; i++) {
      const pick = pickHeroItem("1", [{ key: 1 }], { genreBySection });
      expect(pick.ratingKey).toBe("2");
    }
  });

  it("returns null rather than throwing when genreBySection isn't loaded yet", () => {
    expect(pickHeroItem(undefined, undefined, { genreBySection: undefined })).toBeNull();
  });
});

describe("pickHeroItemFromPool", () => {
  it("returns null when the pool is empty", () => {
    expect(pickHeroItemFromPool(undefined, [])).toBeNull();
  });

  it("dedupes by ratingKey", () => {
    const pool = [{ ratingKey: "1" }, { ratingKey: "1" }, { ratingKey: "2" }];
    for (let i = 0; i < 10; i++) {
      expect(["1", "2"]).toContain(pickHeroItemFromPool(undefined, pool).ratingKey);
    }
  });

  it("excludes the given ratingKey when more than one candidate remains", () => {
    const pool = [{ ratingKey: "1" }, { ratingKey: "2" }];
    for (let i = 0; i < 10; i++) {
      expect(pickHeroItemFromPool("1", pool).ratingKey).toBe("2");
    }
  });
});

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration(90 * 60000)).toBe("1h 30m");
    expect(formatDuration(120 * 60000)).toBe("2h");
    expect(formatDuration(45 * 60000)).toBe("45m");
  });
  it("returns empty for falsy input", () => {
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(null)).toBe("");
  });
});

describe("heroArtUrl", () => {
  it("prefers item.art, falling back to grandparentArt", () => {
    const plexImageUrl = (p) => `https://plex.example${p}`;
    expect(heroArtUrl({ art: "/a.jpg", grandparentArt: "/g.jpg" }, plexImageUrl)).toBe("https://plex.example/a.jpg");
    expect(heroArtUrl({ grandparentArt: "/g.jpg" }, plexImageUrl)).toBe("https://plex.example/g.jpg");
  });
});

describe("heroSubtitleText", () => {
  it("joins year, rating, genres, and runtime with a separator", () => {
    const text = heroSubtitleText({ year: 2021, contentRating: "PG-13", Genre: [{ tag: "Sci-Fi" }, { tag: "Adventure" }], duration: 120 * 60000 });
    expect(text).toBe("2021   •   PG-13   •   Sci-Fi, Adventure   •   2h");
  });
  it("omits missing fields", () => {
    expect(heroSubtitleText({})).toBe("");
  });
});

describe("heroShouldPlay", () => {
  it("plays only when not user-paused and everything is visible/focused", () => {
    expect(heroShouldPlay({ heroUserPaused: false, heroInView: true, heroPageVisible: true, heroWindowFocused: true })).toBe(true);
  });
  it("doesn't play if any condition fails", () => {
    expect(heroShouldPlay({ heroUserPaused: true, heroInView: true, heroPageVisible: true, heroWindowFocused: true })).toBe(false);
    expect(heroShouldPlay({ heroUserPaused: false, heroInView: false, heroPageVisible: true, heroWindowFocused: true })).toBe(false);
    expect(heroShouldPlay({ heroUserPaused: false, heroInView: true, heroPageVisible: false, heroWindowFocused: true })).toBe(false);
    expect(heroShouldPlay({ heroUserPaused: false, heroInView: true, heroPageVisible: true, heroWindowFocused: false })).toBe(false);
  });
});
