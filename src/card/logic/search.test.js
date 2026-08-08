import { describe, it, expect } from "vitest";
import { parseYearQuery, buildGenreMatchHubs, buildReasonMatchHubs } from "./search.js";

describe("parseYearQuery", () => {
  it("parses a single year", () => {
    expect(parseYearQuery("1999")).toEqual([1999, 1999]);
  });
  it("parses a range, ordering low-high regardless of input order", () => {
    expect(parseYearQuery("2005-1999")).toEqual([1999, 2005]);
    expect(parseYearQuery("1999-2005")).toEqual([1999, 2005]);
  });
  it("returns null for non-year queries", () => {
    expect(parseYearQuery("dune")).toBeNull();
    expect(parseYearQuery("1850")).toBeNull();
  });
});

describe("buildGenreMatchHubs", () => {
  const genreBySection = new Map([
    [
      1,
      [
        { title: "Horror", items: [{ title: "Saw", addedAt: 2 }] },
        { title: "Comedy", items: [{ title: "Airplane", addedAt: 1 }] },
      ],
    ],
    [2, [{ title: "HORROR", items: [{ title: "The Haunting", addedAt: 3 }] }]],
  ]);
  it("matches genres case-insensitively across sections and merges by normalized name", () => {
    const hubs = buildGenreMatchHubs("horror", 10, { genreBySection });
    expect(hubs).toHaveLength(1);
    expect(hubs[0].title).toBe('Genre "Horror"');
    expect(hubs[0].Metadata.map((m) => m.title)).toEqual(["The Haunting", "Saw"]);
  });

  it("returns an empty array for a blank query", () => {
    expect(buildGenreMatchHubs("  ", 10, { genreBySection })).toEqual([]);
  });

  it("marks hasMore when the merged pool exceeds the limit", () => {
    const hubs = buildGenreMatchHubs("horror", 0, { genreBySection });
    expect(hubs[0].hasMore).toBe(true);
    expect(hubs[0].Metadata).toHaveLength(0);
  });
});

describe("buildReasonMatchHubs", () => {
  it("groups metadata by reason + reasonTitle", () => {
    const hubs = [
      {
        Metadata: [
          { reason: "actor", reasonTitle: "Keanu Reeves", title: "The Matrix" },
          { reason: "actor", reasonTitle: "Keanu Reeves", title: "John Wick" },
          { reason: "director", reasonTitle: "Denis Villeneuve", title: "Dune" },
          { reason: "unknown-reason", reasonTitle: "Someone", title: "Ignored" },
          { title: "No reason at all" },
        ],
      },
    ];
    const result = buildReasonMatchHubs(hubs, 24);
    expect(result).toHaveLength(2);
    const actorHub = result.find((h) => h.title.includes("Keanu Reeves"));
    expect(actorHub.title).toBe('Actor "Keanu Reeves"');
    expect(actorHub.Metadata).toHaveLength(2);
    expect(actorHub.hasMore).toBe(false);
  });

  it("marks hasMore when the source hub was itself capped", () => {
    const hubs = [{ Metadata: [{ reason: "actor", reasonTitle: "X" }, { reason: "actor", reasonTitle: "X" }] }];
    const result = buildReasonMatchHubs(hubs, 2);
    expect(result[0].hasMore).toBe(true);
  });
});
