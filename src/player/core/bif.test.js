import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadBifIndex, findNearestBifFrame, fetchBifFrameUrl, releaseBifIndex } from "./bif.js";

/* Builds a minimal-but-real BIF buffer: header (64 bytes) + (numImages+1) index
   entries + one byte of "JPEG data" per frame, matching the real file's layout closely
   enough to exercise loadBifIndex's actual offset math instead of a hand-picked fixture. */
function buildBifBuffer(frameTimestamps, multiplier = 1000) {
    const headerSize = 64;
    const tableSize = (frameTimestamps.length + 1) * 8;
    const frameSize = 4;
    const totalSize = headerSize + tableSize + frameTimestamps.length * frameSize;
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    const magic = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
    magic.forEach((b, i) => view.setUint8(i, b));
    view.setUint32(12, frameTimestamps.length, true);
    view.setUint32(16, multiplier, true);

    let offset = headerSize + tableSize;
    frameTimestamps.forEach((ts, i) => {
        view.setUint32(headerSize + i * 8, ts, true);
        view.setUint32(headerSize + i * 8 + 4, offset, true);
        offset += frameSize;
    });
    // Trailing sentinel entry - offset only, timestamp unused by loadBifIndex.
    view.setUint32(headerSize + frameTimestamps.length * 8 + 4, offset, true);
    return buf;
}

function mockRangeFetch(buf) {
    global.fetch = vi.fn(async (url, opts) => {
        const match = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return {
            ok: true,
            arrayBuffer: async () => buf.slice(start, end + 1),
        };
    });
}

describe("loadBifIndex", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("parses header + frame table into {timeMs, offset, length} entries", async () => {
        const buf = buildBifBuffer([0, 2, 5, 9]);
        mockRangeFetch(buf);
        const index = await loadBifIndex("http://example.com/bif");
        expect(index.frames).toHaveLength(4);
        expect(index.frames[0]).toMatchObject({ timeMs: 0 });
        expect(index.frames[1]).toMatchObject({ timeMs: 2000 });
        expect(index.frames[2]).toMatchObject({ timeMs: 5000 });
        expect(index.frames[3]).toMatchObject({ timeMs: 9000 });
        // Every frame here is the same fixed size (4 bytes of fake JPEG data).
        index.frames.forEach((f) => expect(f.length).toBe(4));
    });

    it("returns null when the magic bytes don't match", async () => {
        const buf = new ArrayBuffer(64);
        mockRangeFetch(buf);
        expect(await loadBifIndex("http://example.com/not-bif")).toBeNull();
    });

    it("returns null when the fetch itself fails", async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
        expect(await loadBifIndex("http://example.com/bif")).toBeNull();
    });
});

describe("findNearestBifFrame", () => {
    const index = { frames: [{ timeMs: 0 }, { timeMs: 2000 }, { timeMs: 5000 }, { timeMs: 9000 }] };

    it("finds the closest frame on either side", () => {
        expect(findNearestBifFrame(index, 100).timeMs).toBe(0);
        expect(findNearestBifFrame(index, 3400).timeMs).toBe(2000);
        expect(findNearestBifFrame(index, 3600).timeMs).toBe(5000);
        expect(findNearestBifFrame(index, 100000).timeMs).toBe(9000);
    });

    it("returns null for an index with no frames", () => {
        expect(findNearestBifFrame({ frames: [] }, 1000)).toBeNull();
        expect(findNearestBifFrame(null, 1000)).toBeNull();
    });
});

describe("fetchBifFrameUrl / releaseBifIndex", () => {
    beforeEach(() => {
        global.URL.createObjectURL = vi.fn((blob) => `blob:mock-${Math.random()}`);
        global.URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("caches a blob URL per frame offset instead of re-fetching", async () => {
        const buf = buildBifBuffer([0, 2000]);
        mockRangeFetch(buf);
        const index = await loadBifIndex("http://example.com/bif");
        const frame = index.frames[0];

        const url1 = await fetchBifFrameUrl(index, frame);
        const fetchCallsAfterFirst = global.fetch.mock.calls.length;
        const url2 = await fetchBifFrameUrl(index, frame);

        expect(url2).toBe(url1);
        expect(global.fetch.mock.calls.length).toBe(fetchCallsAfterFirst);
        expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it("revokes every cached URL for an index on release", async () => {
        const buf = buildBifBuffer([0, 2000]);
        mockRangeFetch(buf);
        const index = await loadBifIndex("http://example.com/bif");
        await fetchBifFrameUrl(index, index.frames[0]);
        await fetchBifFrameUrl(index, index.frames[1]);

        releaseBifIndex(index);
        expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    });
});
