import { describe, it, expect } from "vitest";
import { collapseByGuid, resolveSources, matchEpisodesAcrossServers, dedupeSourcesByServer } from "./cross-server.js";

const srvA = { id: "a", name: "PotrykusPlex", owned: true };
const srvB = { id: "b", name: "LookingGlass", owned: false };

describe("resolveSources", () => {
  it("puts the owned server first regardless of input order", () => {
    const sources = resolveSources([
      { __server: srvB, ratingKey: "2", key: "/k2" },
      { __server: srvA, ratingKey: "1", key: "/k1" },
    ]);
    expect(sources.map((s) => s.server.id)).toEqual(["a", "b"]);
    expect(sources[0]).toEqual({ server: srvA, ratingKey: "1", key: "/k1" });
  });

  it("collapses more than one raw item from the same server into one source entry", () => {
    /* Mirrors a title tagged with two genres landing in two different genre buckets from
       the same section before buildRecommendedRaw/buildPopularRaw flatten them together -
       both raw items are really the same server's same copy. */
    const sources = resolveSources([
      { __server: srvA, ratingKey: "1", key: "/k1" },
      { __server: srvA, ratingKey: "1", key: "/k1" },
      { __server: srvB, ratingKey: "9", key: "/k9" },
    ]);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.server.id)).toEqual(["a", "b"]);
  });
});

describe("dedupeSourcesByServer", () => {
  it("keeps the first entry per server id and drops later duplicates", () => {
    const sources = [
      { server: srvA, ratingKey: "1", key: "/k1" },
      { server: srvB, ratingKey: "9", key: "/k9" },
      { server: srvA, ratingKey: "1", key: "/k1" },
    ];
    expect(dedupeSourcesByServer(sources)).toEqual([
      { server: srvA, ratingKey: "1", key: "/k1" },
      { server: srvB, ratingKey: "9", key: "/k9" },
    ]);
  });

  it("handles an empty or missing input gracefully", () => {
    expect(dedupeSourcesByServer([])).toEqual([]);
    expect(dedupeSourcesByServer(undefined)).toEqual([]);
  });
});

describe("collapseByGuid", () => {
  it("passes through a list with no cross-server duplicates unchanged", () => {
    const items = [
      { guid: "g1", ratingKey: "1", __server: srvA },
      { guid: "g2", ratingKey: "2", __server: srvA },
    ];
    const result = collapseByGuid(items);
    expect(result).toHaveLength(2);
    expect(result[0].__sources).toBeUndefined();
  });

  it("collapses same-guid items from different servers into one representative with sources", () => {
    const items = [
      { guid: "g1", ratingKey: "1", __server: srvA },
      { guid: "g1", ratingKey: "9", __server: srvB },
    ];
    const result = collapseByGuid(items);
    expect(result).toHaveLength(1);
    expect(result[0].ratingKey).toBe("1");
    expect(result[0].__sources).toHaveLength(2);
    expect(result[0].__sources[0].server.id).toBe("a");
  });

  it("prefers the owned server as the representative even when it appears second", () => {
    const items = [
      { guid: "g1", ratingKey: "9", __server: srvB },
      { guid: "g1", ratingKey: "1", __server: srvA },
    ];
    const result = collapseByGuid(items);
    expect(result).toHaveLength(1);
    expect(result[0].ratingKey).toBe("1");
  });

  it("passes items with no guid through untouched, never dropping them", () => {
    const items = [{ ratingKey: "1", __server: srvA }, { ratingKey: "2", __server: srvA }];
    expect(collapseByGuid(items)).toEqual(items);
  });

  it("preserves relative order of the first occurrence of each guid", () => {
    const items = [
      { guid: "g1", ratingKey: "1", __server: srvA },
      { guid: "g2", ratingKey: "2", __server: srvA },
      { guid: "g1", ratingKey: "9", __server: srvB },
    ];
    const result = collapseByGuid(items);
    expect(result.map((m) => m.guid)).toEqual(["g1", "g2"]);
  });

  it("handles an empty or missing input gracefully", () => {
    expect(collapseByGuid([])).toEqual([]);
    expect(collapseByGuid(undefined)).toEqual([]);
  });
});

describe("matchEpisodesAcrossServers", () => {
  it("matches episodes by guid across a second server", () => {
    const own = [
      { ratingKey: "1", key: "/k1", guid: "eg1", parentIndex: 1, index: 1 },
      { ratingKey: "2", key: "/k2", guid: "eg2", parentIndex: 1, index: 2 },
    ];
    const other = [
      { ratingKey: "9", key: "/k9", guid: "eg1", parentIndex: 1, index: 1 },
    ];
    const result = matchEpisodesAcrossServers(own, srvA, [{ server: srvB, episodes: other }]);
    expect(result.size).toBe(1);
    expect(result.get("1")).toEqual([
      { server: srvA, ratingKey: "1", key: "/k1" },
      { server: srvB, ratingKey: "9", key: "/k9" },
    ]);
    expect(result.has("2")).toBe(false);
  });

  it("falls back to season+episode number when guid is missing", () => {
    const own = [{ ratingKey: "1", key: "/k1", guid: null, parentIndex: 2, index: 5 }];
    const other = [{ ratingKey: "9", key: "/k9", guid: null, parentIndex: 2, index: 5 }];
    const result = matchEpisodesAcrossServers(own, srvA, [{ server: srvB, episodes: other }]);
    expect(result.get("1")[1]).toEqual({ server: srvB, ratingKey: "9", key: "/k9" });
  });

  it("returns an empty map when nothing matches on any other server", () => {
    const own = [{ ratingKey: "1", key: "/k1", guid: "eg1", parentIndex: 1, index: 1 }];
    const other = [{ ratingKey: "9", key: "/k9", guid: "different", parentIndex: 9, index: 9 }];
    const result = matchEpisodesAcrossServers(own, srvA, [{ server: srvB, episodes: other }]);
    expect(result.size).toBe(0);
  });
});
