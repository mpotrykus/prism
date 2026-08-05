import { describe, it, expect } from "vitest";
import { normalizeTitle, isInWatchlist } from "./watchlist-match.js";

describe("normalizeTitle", () => {
  it("strips punctuation and lowercases", () => {
    expect(normalizeTitle("The Matrix: Reloaded!")).toBe("thematrixreloaded");
  });
  it("handles empty input", () => {
    expect(normalizeTitle(null)).toBe("");
  });
});

describe("isInWatchlist", () => {
  const watchlistRaw = [{ title: "Dune: Part Two", year: 2024 }];

  it("matches despite punctuation differences", () => {
    expect(isInWatchlist({ title: "Dune Part Two", year: 2024 }, watchlistRaw)).toBe(true);
  });

  it("doesn't match a different year", () => {
    expect(isInWatchlist({ title: "Dune Part Two", year: 2021 }, watchlistRaw)).toBe(false);
  });

  it("matches when the item has no year to disambiguate", () => {
    expect(isInWatchlist({ title: "Dune Part Two" }, watchlistRaw)).toBe(true);
  });

  it("is false for a title not on the list", () => {
    expect(isInWatchlist({ title: "Arrival" }, watchlistRaw)).toBe(false);
  });

  it("handles an empty/undefined watchlist", () => {
    expect(isInWatchlist({ title: "Arrival" }, undefined)).toBe(false);
  });
});
