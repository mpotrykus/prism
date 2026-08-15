/* SubRip (.srt) parsing plus "which cues are showing at this position", split out of
   ui/chrome-subtitles.js as pure functions so subtitle-cues.test.js can exercise the
   real-world .srt shapes directly (missing hour field, WebVTT-style `.` separators,
   trailing cue-settings after the timestamp, CRLF, BOM, blocks with no cue number).

   This replaces the old approach of converting .srt to WebVTT, wrapping it in a blob URL,
   attaching it as a <video><track>, and driving the overlay off the browser's own
   `cuechange` event. Two reasons that had to go, beyond one less blob-URL lifecycle to
   manage:

   1. It only works on a real <video> element. The Xbox shell's native player has no
      <video> to attach a track to, and re-implementing subtitle rendering natively (as
      Android had to) would mean a second renderer for the same .srt text.
   2. A sync offset had to be applied by mutating every cue's startTime/endTime, which
      meant it couldn't be applied until the <track> had asynchronously finished parsing -
      the reason attachSubtitleTrack used to return a load promise. Here the offset is
      read at lookup time, so ordering stops mattering at all. */

/* Accepts `HH:MM:SS,mmm`, `MM:SS,mmm`, and either `,` or `.` as the fractional separator
   (some files in the wild are really WebVTT renamed to .srt). Fractions of 1-3 digits are
   scaled rather than assumed to be milliseconds - `,5` means 500ms, not 5ms. */
const TIMESTAMP_RE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function parseTimestamp(raw) {
    const m = TIMESTAMP_RE.exec(raw);
    if (!m) return null;
    const [, hours, minutes, seconds, fraction] = m;
    const ms = Number(fraction.padEnd(3, "0"));
    return ((Number(hours || 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + ms;
}

/* Returns cues sorted by start time: `[{ startMs, endMs, text }]`, where `text` keeps its
   internal newlines and any legacy inline markup (<b>/<i>/<u>/<font color>) for the
   renderer to escape and selectively re-enable - see renderSubtitleCueHtml.

   Malformed blocks are skipped rather than throwing. A subtitle file is untrusted
   third-party input that this player has no way to validate ahead of time, and one bad
   block is not a reason to lose the other two thousand. */
export function parseSubtitleCues(srtText) {
    if (!srtText) return [];
    const normalized = srtText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const cues = [];
    for (const block of normalized.split(/\n{2,}/)) {
        const lines = block.split("\n");
        const arrowIndex = lines.findIndex((line) => line.includes("-->"));
        if (arrowIndex === -1) continue;
        const [left, right] = lines[arrowIndex].split("-->");
        const startMs = parseTimestamp(left || "");
        /* Only the leading timestamp on the right-hand side is the end time - anything
           after it is cue settings (WebVTT `align:`/`line:`, or the legacy SRT
           `X1:.. X2:..` coordinates), which this renderer doesn't honor. */
        const endMs = parseTimestamp(right || "");
        if (startMs == null || endMs == null) continue;
        const text = lines.slice(arrowIndex + 1).join("\n").trim();
        if (!text) continue;
        cues.push({ startMs, endMs, text });
    }
    cues.sort((a, b) => a.startMs - b.startMs);
    return cues;
}

/* The cues showing at `positionMs`, with `offsetMs` shifting the whole file later
   (positive) or earlier (negative). Applied here rather than baked into the cues so the
   Sync +/- control is a pure re-read with nothing to recompute or re-parse.

   Overlapping cues are all returned (real files do stack two speakers), in start order.
   `cues` is assumed sorted, as parseSubtitleCues returns it, which is what lets the scan
   stop at the first cue that hasn't started yet. */
export function activeCuesAt(cues, positionMs, offsetMs = 0) {
    if (!cues?.length) return [];
    const at = positionMs - offsetMs;
    const active = [];
    for (const cue of cues) {
        if (cue.startMs > at) break;
        if (cue.endMs >= at) active.push(cue);
    }
    return active;
}
