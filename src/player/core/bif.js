/* Parses Plex's BIF trickplay index (the same format Roku/Netflix-style scrub-preview
   thumbnails use - "\x89BIF\r\n\x1a\n" magic, a 64-byte header, then a table of
   {timestamp, byteOffset} pairs, then raw JPEG frame data back to back) so the seek bar
   can show a live preview while hovering/dragging. Fetched via HTTP Range requests
   rather than downloading the whole file - a movie-length BIF is commonly 20-30MB, but
   only the 64-byte header + a small index table are needed up front, and individual
   frames (a few KB each) are fetched on demand as the user scrubs near them. */

const BIF_MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_SIZE = 64;

async function rangeFetch(url, start, end) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok) throw new Error(`BIF range fetch failed: HTTP ${res.status}`);
    return res.arrayBuffer();
}

/* Returns null (rather than throwing) on any parse failure - a malformed/unexpected
   file just means no scrub preview for this session, not a broken player. */
export async function loadBifIndex(url) {
    try {
        const header = new DataView(await rangeFetch(url, 0, HEADER_SIZE - 1));
        for (let i = 0; i < BIF_MAGIC.length; i++) {
            if (header.getUint8(i) !== BIF_MAGIC[i]) return null;
        }
        const numImages = header.getUint32(12, true);
        const multiplier = header.getUint32(16, true) || 1000;
        if (!numImages) return null;

        /* numImages+1 entries - the trailing one exists only so every real frame's
           byte length can be computed as (next entry's offset - this entry's offset)
           without a special case for the last frame. */
        const tableBytes = (numImages + 1) * 8;
        const table = new DataView(await rangeFetch(url, HEADER_SIZE, HEADER_SIZE + tableBytes - 1));
        const frames = [];
        for (let i = 0; i < numImages; i++) {
            const timestamp = table.getUint32(i * 8, true);
            const offset = table.getUint32(i * 8 + 4, true);
            const nextOffset = table.getUint32((i + 1) * 8 + 4, true);
            frames.push({ timeMs: timestamp * multiplier, offset, length: nextOffset - offset });
        }
        return { url, frames };
    } catch (e) {
        return null;
    }
}

/* Binary search for the frame whose timestamp is closest to timeMs - frames are
   already in ascending time order per the BIF spec. */
export function findNearestBifFrame(index, timeMs) {
    const frames = index?.frames;
    if (!frames?.length) return null;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].timeMs < timeMs) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(frames[lo - 1].timeMs - timeMs) <= Math.abs(frames[lo].timeMs - timeMs)) {
        return frames[lo - 1];
    }
    return frames[lo];
}

/* One blob-URL cache per loaded index (keyed by the index object itself, not the url
   string, so a stale index from a previous title can never leak a frame under a new
   session) - releaseBifIndex revokes everything in it at once when the player stops or
   switches titles. */
const frameCaches = new WeakMap();

export async function fetchBifFrameUrl(index, frame) {
    let cache = frameCaches.get(index);
    if (!cache) {
        cache = new Map();
        frameCaches.set(index, cache);
    }
    const cached = cache.get(frame.offset);
    if (cached) return cached;
    const buf = await rangeFetch(index.url, frame.offset, frame.offset + frame.length - 1);
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
    cache.set(frame.offset, blobUrl);
    return blobUrl;
}

export function releaseBifIndex(index) {
    const cache = frameCaches.get(index);
    if (!cache) return;
    for (const url of cache.values()) URL.revokeObjectURL(url);
    frameCaches.delete(index);
}
