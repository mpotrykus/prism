import { describe, it, expect } from "vitest";
import { passesKidsMode, isBlockedGenreName } from "./kids-mode.js";

describe("passesKidsMode", () => {
  it("allows everything when Kids Mode is off", () => {
    expect(passesKidsMode({ contentRating: "R" }, { kidsMode: false })).toBe(true);
  });

  it("blocks an item whose Genre tag matches a blocked genre", () => {
    const m = { Genre: [{ tag: "Horror" }], contentRating: "PG" };
    expect(
      passesKidsMode(m, { kidsMode: true, blockedGenres: ["horror"], allowedRatings: ["PG"] })
    ).toBe(false);
  });

  it("blocks an item whose contentRating isn't in the allowed list", () => {
    const m = { Genre: [], contentRating: "PG-13" };
    expect(passesKidsMode(m, { kidsMode: true, blockedGenres: [], allowedRatings: ["G", "PG"] })).toBe(false);
  });

  it("allows an item that clears both checks", () => {
    const m = { Genre: [{ tag: "Comedy" }], contentRating: "PG" };
    expect(
      passesKidsMode(m, { kidsMode: true, blockedGenres: ["horror"], allowedRatings: ["G", "PG"] })
    ).toBe(true);
  });

  it("treats a missing item as passing", () => {
    expect(passesKidsMode(null, { kidsMode: true, allowedRatings: [] })).toBe(true);
  });
});

describe("isBlockedGenreName", () => {
  it("is false when Kids Mode is off", () => {
    expect(isBlockedGenreName("Horror", { kidsMode: false, blockedGenres: ["horror"] })).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isBlockedGenreName("  HORROR  ", { kidsMode: true, blockedGenres: ["horror"] })).toBe(true);
  });

  it("is false for a genre not in the blocked list", () => {
    expect(isBlockedGenreName("Comedy", { kidsMode: true, blockedGenres: ["horror"] })).toBe(false);
  });
});
