import { describe, it, expect } from "vitest";
import {
  shuffle,
  mapItem,
  mergeGenreRows,
  buildRecommendedRaw,
  buildPopularRaw,
  buildCollectionRows,
  buildAiRows,
  parseAiSectionIdeas,
  pickNextEpisode,
} from "./catalog.js";

describe("shuffle", () => {
  it("returns a permutation of the same elements without mutating the input", () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect(result.slice().sort()).toEqual(input.slice().sort());
    expect(result).toHaveLength(input.length);
  });
});

const plexImageUrl = (path) => (path ? `https://plex.example${path}` : "");

describe("mapItem", () => {
  it("maps a movie's fields, preferring its own thumb/title", () => {
    const item = mapItem({ ratingKey: "1", type: "movie", title: "Dune", year: 2021, thumb: "/t.jpg", Genre: [{ tag: "Sci-Fi" }] }, false, { plexImageUrl });
    expect(item).toMatchObject({ ratingKey: "1", type: "movie", title: "Dune", subtitle: "2021", genres: ["Sci-Fi"] });
    expect(item.image).toBe("https://plex.example/t.jpg");
  });

  it("falls back to the show's title/thumb for an episode", () => {
    const item = mapItem({ type: "episode", grandparentTitle: "Show", title: "Pilot", grandparentThumb: "/g.jpg" }, false, { plexImageUrl });
    expect(item.title).toBe("Show");
    expect(item.subtitle).toBe("Pilot");
  });

  it("uses the episode genre fallback when Plex sends none", () => {
    const item = mapItem({ type: "episode", title: "Pilot" }, false, { plexImageUrl, episodeFallbackGenres: ["Drama"] });
    expect(item.genres).toEqual(["Drama"]);
  });

  it("computes progress only when withProgress is set and duration is known", () => {
    const withIt = mapItem({ type: "movie", viewOffset: 50, duration: 100 }, true, { plexImageUrl });
    expect(withIt.progress).toBe(0.5);
    const withoutIt = mapItem({ type: "movie", viewOffset: 50, duration: 100 }, false, { plexImageUrl });
    expect(withoutIt.progress).toBeUndefined();
  });
});

describe("pickNextEpisode", () => {
  it("returns null for an empty/missing list", () => {
    expect(pickNextEpisode([])).toBeNull();
    expect(pickNextEpisode(undefined)).toBeNull();
  });

  it("picks the first episode of a never-started show", () => {
    const episodes = [
      { ratingKey: "1", parentIndex: 1, index: 1, viewCount: 0, viewOffset: 0 },
      { ratingKey: "2", parentIndex: 1, index: 2, viewCount: 0, viewOffset: 0 },
    ];
    expect(pickNextEpisode(episodes)).toBe("1");
  });

  it("picks the in-progress episode over later unwatched ones", () => {
    const episodes = [
      { ratingKey: "1", parentIndex: 1, index: 1, viewCount: 1, viewOffset: 0 },
      { ratingKey: "2", parentIndex: 1, index: 2, viewCount: 0, viewOffset: 12000 },
      { ratingKey: "3", parentIndex: 1, index: 3, viewCount: 0, viewOffset: 0 },
    ];
    expect(pickNextEpisode(episodes)).toBe("2");
  });

  it("picks the first unwatched episode after a run of watched ones, crossing season boundaries", () => {
    const episodes = [
      { ratingKey: "1", parentIndex: 1, index: 1, viewCount: 1, viewOffset: 0 },
      { ratingKey: "2", parentIndex: 1, index: 2, viewCount: 1, viewOffset: 0 },
      { ratingKey: "3", parentIndex: 2, index: 1, viewCount: 0, viewOffset: 0 },
    ];
    expect(pickNextEpisode(episodes)).toBe("3");
  });

  it("restarts from the first episode when the whole series is fully watched", () => {
    const episodes = [
      { ratingKey: "1", parentIndex: 1, index: 1, viewCount: 1, viewOffset: 0 },
      { ratingKey: "2", parentIndex: 1, index: 2, viewCount: 1, viewOffset: 0 },
    ];
    expect(pickNextEpisode(episodes)).toBe("1");
  });

  it("sorts out-of-order input by season/episode index", () => {
    const episodes = [
      { ratingKey: "2", parentIndex: 1, index: 2, viewCount: 0, viewOffset: 0 },
      { ratingKey: "1", parentIndex: 1, index: 1, viewCount: 0, viewOffset: 0 },
    ];
    expect(pickNextEpisode(episodes)).toBe("1");
  });
});

const identityMapItem = (m) => m;
const noShuffle = (arr) => arr;

describe("mergeGenreRows", () => {
  it("merges same-named genres across sections and drops small buckets", () => {
    const genreBySection = new Map([
      [1, [{ title: "Horror", items: [{ addedAt: 1 }, { addedAt: 2 }, { addedAt: 3 }, { addedAt: 4 }, { addedAt: 5 }], totalSize: 5 }]],
      [2, [{ title: "horror", items: [{ addedAt: 6 }], totalSize: 1 }]],
      [3, [{ title: "Tiny", items: [{ addedAt: 1 }], totalSize: 1 }]],
    ]);
    const rows = mergeGenreRows([{ key: 1 }, { key: 2 }, { key: 3 }], {
      genreBySection,
      mapItem: identityMapItem,
      shuffle: noShuffle,
      rowSize: 20,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Horror");
    expect(rows[0].items).toHaveLength(6);
  });
});

describe("buildRecommendedRaw", () => {
  const genreBySection = new Map([
    [
      1,
      [
        { title: "Sci-Fi", items: [{ ratingKey: "1", Genre: [{ tag: "Sci-Fi" }] }, { ratingKey: "2", Genre: [{ tag: "Sci-Fi" }] }] },
        { title: "Comedy", items: [{ ratingKey: "3", Genre: [{ tag: "Comedy" }] }] },
      ],
    ],
  ]);

  it("scores unwatched items by genre overlap with watch history, excluding watched/on-deck items", () => {
    const historyRaw = [{ ratingKey: "1", Genre: [{ tag: "Sci-Fi" }] }];
    const raw = buildRecommendedRaw(historyRaw, { genreBySection, onDeckRaw: [] });
    expect(raw.map((m) => m.ratingKey)).toEqual(["2"]);
  });

  it("returns nothing when watch history has no genre signal", () => {
    const raw = buildRecommendedRaw([], { genreBySection, onDeckRaw: [] });
    expect(raw).toEqual([]);
  });
});

describe("buildPopularRaw", () => {
  it("blends recency and rating into a descending score", () => {
    const genreBySection = new Map([
      [
        1,
        [
          {
            title: "All",
            items: [
              { ratingKey: "old", year: 2000, audienceRating: 9 },
              { ratingKey: "new", year: 2024, audienceRating: 9 },
            ],
          },
        ],
      ],
    ]);
    const raw = buildPopularRaw({ genreBySection });
    expect(raw[0].ratingKey).toBe("new");
  });

  it("skips items missing year or audienceRating", () => {
    const genreBySection = new Map([[1, [{ title: "All", items: [{ ratingKey: "x" }] }]]]);
    expect(buildPopularRaw({ genreBySection })).toEqual([]);
  });
});

describe("buildCollectionRows", () => {
  it("maps and filters out empty collections after typeFilter", () => {
    const raw = [
      { title: "Marvel", items: [{ type: "movie" }, { type: "show" }] },
      { title: "Empty", items: [{ type: "show" }] },
    ];
    const rows = buildCollectionRows(raw, (m) => m.type === "movie", { mapItem: identityMapItem, rowSize: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Marvel");
    expect(rows[0].source).toBe("collection");
  });
});

describe("buildAiRows", () => {
  it("drops rows under 5 items", () => {
    const raw = [
      { label: "Sci-Fi Comedy", genres: ["Sci-Fi", "Comedy"], items: Array(5).fill({ type: "movie", addedAt: 1 }) },
      { label: "Too Few", genres: ["Drama"], items: [{ type: "movie" }] },
    ];
    const rows = buildAiRows(raw, () => true, {
      mapItem: identityMapItem,
      rowSize: 20,
    });
    expect(rows.map((r) => r.title)).toEqual(["Sci-Fi Comedy"]);
  });
});

describe("parseAiSectionIdeas", () => {
  it("parses a plain JSON array", () => {
    const raw = JSON.stringify([{ label: "Space Adventures", genres: ["Sci-Fi", "Adventure"] }]);
    expect(parseAiSectionIdeas(raw)).toEqual([{ label: "Space Adventures", genres: ["Sci-Fi", "Adventure"] }]);
  });

  it("strips a markdown code fence", () => {
    const raw = "```json\n" + JSON.stringify([{ label: "X", genres: ["Drama"] }]) + "\n```";
    expect(parseAiSectionIdeas(raw)).toHaveLength(1);
  });

  it("filters out malformed ideas", () => {
    const raw = JSON.stringify([{ label: "", genres: ["Drama"] }, { label: "Ok", genres: [] }, { label: "Good", genres: ["Drama", "Comedy"] }]);
    expect(parseAiSectionIdeas(raw)).toEqual([{ label: "Good", genres: ["Drama", "Comedy"] }]);
  });

  it("returns an empty array for garbage input", () => {
    expect(parseAiSectionIdeas("not json")).toEqual([]);
    expect(parseAiSectionIdeas(null)).toEqual([]);
  });
});
