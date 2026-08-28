import { describe, it, expect } from "vitest";
import { normalizeTitle, isInWatchlist, findLocalMatch } from "./watchlist-match.js";

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

describe("findLocalMatch", () => {
  const pool = [
    { title: "Dune: Part Two", year: 2024, __server: { id: "srv1" } },
    { title: "Arrival", year: 2016, __server: { id: "srv2" } },
  ];

  it("returns the matching pool item so its stamps (e.g. __server) can be borrowed", () => {
    expect(findLocalMatch({ title: "Dune Part Two", year: 2024 }, pool)).toBe(pool[0]);
  });

  it("returns undefined when nothing matches", () => {
    expect(findLocalMatch({ title: "Not In Pool" }, pool)).toBeUndefined();
  });

  it("returns undefined for an empty/undefined pool", () => {
    expect(findLocalMatch({ title: "Arrival" }, undefined)).toBeUndefined();
  });
});
