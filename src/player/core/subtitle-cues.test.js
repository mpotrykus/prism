import { describe, it, expect } from "vitest";
import { parseSubtitleCues, activeCuesAt } from "./subtitle-cues.js";

const BASIC = `1
00:00:01,000 --> 00:00:04,000
Hello there

2
00:00:05,500 --> 00:00:07,250
Line one
Line two
`;

describe("parseSubtitleCues", () => {
    it("parses cue numbers, timestamps and multi-line text", () => {
        expect(parseSubtitleCues(BASIC)).toEqual([
            { startMs: 1000, endMs: 4000, text: "Hello there" },
            { startMs: 5500, endMs: 7250, text: "Line one\nLine two" },
        ]);
    });

    it("handles CRLF line endings and a leading BOM", () => {
        const cues = parseSubtitleCues("﻿1\r\n00:00:02,000 --> 00:00:03,000\r\nHi\r\n");
        expect(cues).toEqual([{ startMs: 2000, endMs: 3000, text: "Hi" }]);
    });

    it("accepts a WebVTT-style dot as the fractional separator", () => {
        expect(parseSubtitleCues("00:00:01.500 --> 00:00:02.500\nHi")[0]).toEqual({
            startMs: 1500,
            endMs: 2500,
            text: "Hi",
        });
    });

    it("accepts blocks with no cue number", () => {
        expect(parseSubtitleCues("00:00:01,000 --> 00:00:02,000\nHi")).toHaveLength(1);
    });

    it("accepts an omitted hour field", () => {
        expect(parseSubtitleCues("01:20,000 --> 01:22,000\nHi")[0]).toMatchObject({
            startMs: 80000,
            endMs: 82000,
        });
    });

    it("scales 1- and 2-digit fractions instead of reading them as milliseconds", () => {
        expect(parseSubtitleCues("00:00:01,5 --> 00:00:02,25\nHi")[0]).toMatchObject({
            startMs: 1500,
            endMs: 2250,
        });
    });

    it("ignores cue settings trailing the end timestamp", () => {
        expect(parseSubtitleCues("00:00:01,000 --> 00:00:02,000 X1:100 X2:200\nHi")[0]).toMatchObject({
            endMs: 2000,
        });
    });

    it("preserves legacy inline markup for the renderer to handle", () => {
        expect(parseSubtitleCues("00:00:01,000 --> 00:00:02,000\n<i>Hi</i>")[0].text).toBe("<i>Hi</i>");
    });

    it("skips malformed and empty blocks rather than throwing", () => {
        const cues = parseSubtitleCues(`1
not a timestamp
Some text

2
00:00:09,000 --> 00:00:10,000

3
00:00:11,000 --> 00:00:12,000
Kept`);
        expect(cues).toEqual([{ startMs: 11000, endMs: 12000, text: "Kept" }]);
    });

    it("returns [] for empty or missing input", () => {
        expect(parseSubtitleCues("")).toEqual([]);
        expect(parseSubtitleCues(undefined)).toEqual([]);
    });

    it("sorts cues by start time", () => {
        const cues = parseSubtitleCues(`00:00:09,000 --> 00:00:10,000
Second

00:00:01,000 --> 00:00:02,000
First`);
        expect(cues.map((c) => c.text)).toEqual(["First", "Second"]);
    });
});

describe("activeCuesAt", () => {
    const cues = parseSubtitleCues(BASIC);

    it("returns the cue covering the position", () => {
        expect(activeCuesAt(cues, 2000).map((c) => c.text)).toEqual(["Hello there"]);
    });

    it("returns nothing in the gap between cues", () => {
        expect(activeCuesAt(cues, 4500)).toEqual([]);
    });

    it("treats both cue boundaries as inclusive", () => {
        expect(activeCuesAt(cues, 1000)).toHaveLength(1);
        expect(activeCuesAt(cues, 4000)).toHaveLength(1);
    });

    it("shifts the whole file later for a positive offset", () => {
        expect(activeCuesAt(cues, 2000, 2000)).toEqual([]);
        expect(activeCuesAt(cues, 4000, 2000).map((c) => c.text)).toEqual(["Hello there"]);
    });

    it("shifts the whole file earlier for a negative offset", () => {
        /* Cue 2 is 5500-7250, so a -1000 offset shows it over 4500-6250: still absent at
           4000, present at 5000 where it otherwise would not be. */
        expect(activeCuesAt(cues, 4000, -1000)).toEqual([]);
        expect(activeCuesAt(cues, 5000, -1000).map((c) => c.text)).toEqual(["Line one\nLine two"]);
    });

    it("returns every overlapping cue in start order", () => {
        const overlapping = parseSubtitleCues(`00:00:01,000 --> 00:00:05,000
A

00:00:02,000 --> 00:00:03,000
B`);
        expect(activeCuesAt(overlapping, 2500).map((c) => c.text)).toEqual(["A", "B"]);
    });

    it("returns [] for empty or missing cue lists", () => {
        expect(activeCuesAt([], 1000)).toEqual([]);
        expect(activeCuesAt(undefined, 1000)).toEqual([]);
    });
});
