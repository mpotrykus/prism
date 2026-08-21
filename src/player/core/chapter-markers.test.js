import { describe, it, expect } from "vitest";
import { deriveChapterMarkers } from "./chapter-markers.js";

/* Fixtures are real chapter shapes pulled from a live Plex server (see this file's
   sibling module comment) - not hand-invented, to keep the thresholds honest. */
const champlooChapters = [
    { tag: "4 Ending", startTimeOffset: 0, endTimeOffset: 1201 },
    { tag: "5 Opening", startTimeOffset: 1201, endTimeOffset: 91324 },
    { tag: "6 Part A", startTimeOffset: 91324, endTimeOffset: 655121 },
    { tag: "7 Part B", startTimeOffset: 655121, endTimeOffset: 1296160 },
    { tag: "8 Ending", startTimeOffset: 1296160, endTimeOffset: 1400960 },
];
const champlooDurationMs = 1401023;

const houseChapters = [
    { startTimeOffset: 0, endTimeOffset: 100100 },
    { startTimeOffset: 100100, endTimeOffset: 763805 },
    { startTimeOffset: 763805, endTimeOffset: 1300170 },
    { startTimeOffset: 1300170, endTimeOffset: 1904820 },
    { startTimeOffset: 1904820, endTimeOffset: 2560020 },
    { startTimeOffset: 2560020, endTimeOffset: 2596636 },
];
const houseDurationMs = 2596636;

describe("deriveChapterMarkers", () => {
    it("only runs for episodes", () => {
        expect(deriveChapterMarkers(champlooChapters, champlooDurationMs, "movie")).toEqual([]);
    });

    it("maps tagged Opening/Ending chapters directly, ignoring the leftover sliver", () => {
        const markers = deriveChapterMarkers(champlooChapters, champlooDurationMs, "episode");
        expect(markers).toEqual([
            { type: "intro", startTimeOffset: 1201, endTimeOffset: 91324 },
            { type: "credits", startTimeOffset: 1296160, endTimeOffset: 1400960 },
        ]);
    });

    it("derives only a credits region for untagged chapters, never an intro", () => {
        const markers = deriveChapterMarkers(houseChapters, houseDurationMs, "episode");
        expect(markers).toEqual([{ type: "credits", startTimeOffset: 2560020, endTimeOffset: 2596636 }]);
    });

    it("skips the untagged credits fallback when the last chapter runs too long", () => {
        const chapters = [
            { startTimeOffset: 0, endTimeOffset: 500000 },
            { startTimeOffset: 500000, endTimeOffset: 2500000 },
        ];
        expect(deriveChapterMarkers(chapters, 2500000, "episode")).toEqual([]);
    });

    it("skips the untagged credits fallback when the last chapter isn't near the end", () => {
        const chapters = [
            { startTimeOffset: 0, endTimeOffset: 1000000 },
            { startTimeOffset: 1000000, endTimeOffset: 2000000 },
            { startTimeOffset: 2000000, endTimeOffset: 2060000 },
        ];
        expect(deriveChapterMarkers(chapters, 2500000, "episode")).toEqual([]);
    });

    it("returns nothing with no chapters or no duration", () => {
        expect(deriveChapterMarkers([], champlooDurationMs, "episode")).toEqual([]);
        expect(deriveChapterMarkers(champlooChapters, 0, "episode")).toEqual([]);
    });
});
