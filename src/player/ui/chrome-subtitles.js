import { Capacitor } from "@capacitor/core";
import * as StreamingSubtitles from "../core/subtitle-provider.js";
import * as subtitleStore from "../core/subtitle-store.js";
import { reloadWebSource, trySwitchAudioTrackLocal } from "../web-fallback.js";
import { setNativeSubtitle, setNativeSubtitleOffset, notifyNativeSubtitleApplied } from "../native-bridge.js";
import { hideControls, showControls } from "./chrome-controls.js";
import { closeInlineMenu, renderPickerList } from "./chrome-menu.js";
import { SHEET_GRADIENT, MENU_SCROLL_CLASS } from "./shared.js";

/* Audio Track/Subtitles picker (its own right-anchored overlay, opened from the
   transport bar's dedicated icon - see chrome-transport.js) plus everything about
   attaching/offsetting/rendering a subtitle track on the web/Xbox <video> leg. Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state.

   Circular with web-fallback.js (which imports closeAudioSubtitlesOverlay from this
   file) - safe here for the same reason documented in web-fallback.js's own header
   comment: reloadWebSource is only ever called from inside a click handler below, never
   at module-top-level evaluation time. */

function renderAudioSection(controller, content, { setValue, collapse }) {
    content.innerHTML = "";
    const streams = controller._session?.audioStreams || [];
    const current = controller._session?.audioStreamId;
    renderPickerList(content, streams.map((stream) => ({
        label: `${stream.label}${stream.id === current ? "  ✓" : ""}`,
        onSelect: () => {
            /* Local switch first (see trySwitchAudioTrackLocal's own header comment) -
               falls back to the old full-session-restart path only when hls.js can't
               offer the same track count Plex's Part advertises (e.g. the native-HLS
               <video> fallback, or a server/source combination where directStreamAudio
               didn't produce one EXT-X-MEDIA rendition per audio stream). */
            if (!trySwitchAudioTrackLocal(controller, stream.id)) {
                reloadWebSource(controller, { audioStreamID: stream.id });
            }
            setValue(stream.label);
            collapse();
            /* reloadWebSource updates controller._session.audioStreamId synchronously,
               but this picker list was already built above with the old `current` -
               re-render in place so the ✓ moves to the new selection immediately
               instead of only after the overlay/menu is closed and reopened. */
            renderAudioSection(controller, content, { setValue, collapse });
        },
    })));
}

/* Audio Track and Subtitles' merged control, redone as its own right-anchored dialog
   (HBO Max's own audio/subtitle picker is the reference - a compact two-column grid,
   not a full screen) rather than a screen inside the More sheet's own single-list-of-
   rows shape - closes that sheet on the way there, same "own separate overlay" pattern
   openChapterListOverlay uses. The gradient panel itself spans the full screen height
   (top:0/bottom:0, same as the main hamburger sheet) so the fade reaches top to bottom
   even though its actual content is vertically centered and far shorter than that. */
export function openAudioSubtitlesOverlay(controller) {
    closeAudioSubtitlesOverlay(controller);
    closeInlineMenu(controller);

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10002", background: "transparent" });
    scrim.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        zIndex: "10003",
        width: "min(820px, 92vw)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: SHEET_GRADIENT,
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
        padding: "20px 32px 24px",
        opacity: "0",
        transform: "translateX(20px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
        position: "absolute",
        top: "16px",
        right: "16px",
        width: "28px",
        height: "28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "16px",
        cursor: "pointer",
        padding: "0",
    });
    closeBtn.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));
    panel.appendChild(closeBtn);

    /* Audio first (left), Subtitles second (right). Each column caps its own list at a
       fixed max-height and scrolls independently rather than the two needing to match
       heights exactly (unlike this control's previous top/bottom-split incarnation,
       nothing here requires the two columns to be the same height). */
    const grid = document.createElement("div");
    Object.assign(grid.style, { display: "flex", gap: "64px", marginTop: "12px", overflow: "hidden" });

    const audioColumn = buildAudioSubtitlesColumn("Audio");
    renderAudioSection(controller, audioColumn.body, { setValue: () => {}, collapse: () => {} });
    grid.appendChild(audioColumn.el);

    const subtitlesColumn = buildAudioSubtitlesColumn("Subtitles");
    renderSubtitleSection(controller, subtitlesColumn.body, { collapse: () => closeAudioSubtitlesOverlay(controller) });
    grid.appendChild(subtitlesColumn.el);

    panel.appendChild(grid);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._audioSubtitlesEl = { scrim, panel };
    hideControls(controller);
    requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateX(0)";
    });
}

export function closeAudioSubtitlesOverlay(controller) {
    if (!controller._audioSubtitlesEl) return;
    controller._audioSubtitlesEl.scrim.remove();
    controller._audioSubtitlesEl.panel.remove();
    controller._audioSubtitlesEl = null;
    showControls(controller);
}

/* One column of the grid above - a bold heading with a divider underneath (matching
   the HBO reference's "Subtitles"/"Audio" column headers) plus a `body` container the
   caller renders its own picker list into. `body` caps its own height and scrolls
   independently of the other column, rather than the fixed 260px cap
   renderSubtitleSection's results list otherwise still carries - here that cap is
   exactly what "constrain to the height of the parent" already fixed once
   (renderSubtitleSection's own resultsEl is flex:1/minHeight:0, so it fills whatever
   height `body` actually has).

   maxHeight is calc(100vh - fixed chrome) rather than a flat vh percentage (a flat 40vh
   used to cap this well short of the panel's own full height, wasting most of a tall
   screen on a long subtitle-search-results list) - ~130px covers openAudioSubtitlesOverlay's
   panel padding (44px) + this column's own heading (~32px) + body's paddingTop (16px)
   + a margin of safety, so at the cap this genuinely uses close to the entire viewport
   instead of an arbitrary fraction of it. Short lists (Audio, most Subtitle searches)
   still size to their own content and sit centered (openAudioSubtitlesOverlay's own
   panel is justifyContent:"center") - this only changes what happens once content
   actually wants more room than that, which matters most on a short mobile viewport
   where 40vh of actual pixels was cramped rather than just "smaller than desktop". */
function buildAudioSubtitlesColumn(title) {
    const el = document.createElement("div");
    Object.assign(el.style, { flex: "1 1 0", minWidth: "0", display: "flex", flexDirection: "column" });

    const heading = document.createElement("div");
    heading.textContent = title;
    Object.assign(heading.style, {
        flex: "0 0 auto",
        color: "#fff",
        fontSize: "15px",
        fontWeight: "700",
        paddingBottom: "10px",
        borderBottom: "1px solid rgba(255,255,255,0.25)",
    });
    el.appendChild(heading);

    const body = document.createElement("div");
    body.className = MENU_SCROLL_CLASS;
    /* overflowX explicitly "hidden" here - per spec, leaving it at its default
       "visible" while overflowY is "auto" gets it implicitly upgraded to "auto" too,
       which was surfacing a horizontal scrollbar whenever a row's text nudged past the
       column's width. */
    Object.assign(body.style, {
        flex: "1 1 auto",
        minHeight: "0",
        maxHeight: "calc(100vh - 130px)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        overflowX: "hidden",
        paddingTop: "16px",
    });
    el.appendChild(body);

    return { el, body };
}

/* Lives in the player chrome, not the title-info modal - subtitle search is
   realistically a mid-playback action ("I'm already watching, there's no subs, let me
   search") more than a pre-playback picker step. */
function renderSubtitleSection(controller, content, { collapse }) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search subtitles…";
    input.value = controller._session?.title || "";
    Object.assign(input.style, {
        flex: "0 0 auto",
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 8px",
        padding: "9px 12px",
        borderRadius: "8px",
        border: "1px solid rgba(255,255,255,0.15)",
        background: "rgba(255,255,255,0.06)",
        color: "#fff",
        fontSize: "13px",
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
    });

    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.textContent = "Search";
    Object.assign(searchBtn.style, {
        flex: "0 0 auto",
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 10px",
        padding: "9px",
        borderRadius: "8px",
        border: "none",
        background: "#e5a00d",
        color: "#161619",
        fontSize: "13px",
        fontWeight: "700",
        cursor: "pointer",
        boxSizing: "border-box",
    });

    /* flex:1 1 auto/minHeight:0 fills exactly whatever height is left in the parent
       column after the heading/input/button above (see buildAudioSubtitlesColumn) -
       the one and only scroll region for this column, not a second fixed-height
       (previously 260px) scroller nested inside that column's own. */
    const resultsEl = document.createElement("div");
    resultsEl.className = MENU_SCROLL_CLASS;
    Object.assign(resultsEl.style, {
        flex: "1 1 auto",
        minHeight: "0",
        fontSize: "13px",
        color: "rgba(255,255,255,0.7)",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "0 16px",
    });

    const runSearch = async () => {
        if (!input.value.trim()) {
            resultsEl.textContent = "Type something to search for.";
            return;
        }
        resultsEl.textContent = "Searching…";
        try {
            const results = await StreamingSubtitles.search(controller._session, { title: input.value });
            resultsEl.innerHTML = "";
            if (!results.length) {
                resultsEl.textContent = "No results.";
                return;
            }
            const appliedRatingKey = controller._session?.ratingKey;
            results.forEach((r) => {
                const row = document.createElement("button");
                row.type = "button";
                const isApplied = subtitleStore.isAppliedResult(appliedRatingKey, r);
                row.textContent = `${r.label} (${r.languageCode})${isApplied ? "  ✓" : ""}`;
                Object.assign(row.style, {
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 4px",
                    background: "transparent",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "13px",
                    marginBottom: "2px",
                    boxSizing: "border-box",
                });
                row.addEventListener("mouseenter", () => {
                    row.style.background = "rgba(255,255,255,0.1)";
                });
                row.addEventListener("mouseleave", () => {
                    row.style.background = "transparent";
                });
                row.addEventListener("click", () => applySubtitleResult(controller, r, row, collapse));
                resultsEl.appendChild(row);
            });
        } catch (e) {
            resultsEl.textContent = e.message;
        }
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") runSearch();
    });
    searchBtn.addEventListener("click", runSearch);

    content.appendChild(input);
    content.appendChild(searchBtn);
    /* Both only shown once a subtitle is actually attached - offsetting/removing a
       track that doesn't exist yet has nothing to act on. Rebuilt fresh on every render
       (same as the rest of this section) rather than kept in sync some other way, so
       reopening the menu after a fresh applySubtitleResult always picks both up. */
    if (controller._videoEl?.textTracks?.[0]) {
        content.appendChild(buildSubtitleOffsetRow(controller));
        content.appendChild(buildSubtitleOffButton(controller, collapse));
    }
    content.appendChild(resultsEl);

    if (input.value) runSearch();
}

/* Real-world .srt files are commonly a fixed amount early/late against the actual
   video - this nudges every cue's timing by SUBTITLE_OFFSET_STEP_MS per click without
   needing a new download. Kept as a flat +/- control (no numeric entry) to match the
   rest of this menu's picker-row style rather than adding a text input just for this. */
const SUBTITLE_OFFSET_STEP_MS = 250;

function buildSubtitleOffsetRow(controller) {
    const row = document.createElement("div");
    Object.assign(row.style, {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "0 16px 10px",
        gap: "10px",
    });

    const label = document.createElement("span");
    Object.assign(label.style, {
        fontSize: "13px",
        color: "rgba(255,255,255,0.7)",
    });
    const renderLabel = () => {
        const ms = controller._subtitleOffsetMs || 0;
        label.textContent = `Sync: ${ms > 0 ? "+" : ""}${ms}ms`;
    };
    renderLabel();

    const makeStepBtn = (glyph, delta) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = glyph;
        btn.setAttribute("aria-label", delta < 0 ? "Subtitles earlier" : "Subtitles later");
        Object.assign(btn.style, {
            flex: "0 0 auto",
            width: "30px",
            height: "30px",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            fontSize: "16px",
            fontWeight: "700",
            lineHeight: "1",
            cursor: "pointer",
        });
        btn.addEventListener("click", () => {
            adjustSubtitleOffset(controller, delta);
            renderLabel();
        });
        return btn;
    };

    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "6px", flex: "0 0 auto" });
    buttons.appendChild(makeStepBtn("–", -SUBTITLE_OFFSET_STEP_MS));
    buttons.appendChild(makeStepBtn("+", SUBTITLE_OFFSET_STEP_MS));

    row.appendChild(label);
    row.appendChild(buttons);
    return row;
}

/* Plain text-button row, matching the rest of this menu's picker style - removes the
   currently attached subtitle and forgets it (see removeSubtitleResult) rather than
   just hiding it for this session, so it doesn't come back next time this title plays. */
function buildSubtitleOffButton(controller, collapse) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Off";
    Object.assign(btn.style, {
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 10px",
        padding: "9px",
        borderRadius: "8px",
        border: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(255,255,255,0.08)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        boxSizing: "border-box",
    });
    btn.addEventListener("click", () => removeSubtitleResult(controller, collapse));
    return btn;
}

/* Shifts every cue relative to its ORIGINAL parsed time (cue._baseStart/_baseEnd),
   captured lazily on first adjustment here rather than up front when the track loads -
   by the time this menu is reachable a subtitle is already attached and its cues
   already parsed, so a separate <track> "load" listener would just be dead weight.
   Mutating startTime/endTime directly (rather than re-deriving cues from scratch) is
   what makes the browser's own cuechange timeline immediately reflect the new offset.
   Absolute rather than a delta so applyRememberedSubtitle below can restore a
   previously-saved offset in one call, the same function the +/- buttons use. */
function setSubtitleOffset(controller, offsetMs) {
    const textTrack = controller._videoEl?.textTracks?.[0];
    if (!textTrack) return;
    controller._subtitleOffsetMs = offsetMs;
    const offsetSec = offsetMs / 1000;
    Array.from(textTrack.cues || []).forEach((cue) => {
        if (cue._baseStart == null) {
            cue._baseStart = cue.startTime;
            cue._baseEnd = cue.endTime;
        }
        cue.startTime = cue._baseStart + offsetSec;
        cue.endTime = cue._baseEnd + offsetSec;
    });
}

/* Persisted on every click (subtitle-store.js's setAppliedOffsetMs), not just kept in
   controller._subtitleOffsetMs - so a sync adjustment survives closing and reopening
   this title, the same as the subtitle choice itself already does. Web/Xbox only, see
   subtitle-store.js's own header comment for why Android has no equivalent yet. */
function adjustSubtitleOffset(controller, deltaMs) {
    setSubtitleOffset(controller, (controller._subtitleOffsetMs || 0) + deltaMs);
    subtitleStore.setAppliedOffsetMs(controller._session?.ratingKey, controller._subtitleOffsetMs);
}

/* Shared by applySubtitleResult below and applyRememberedSubtitle (called from
   plex-player.js at the start of every session) so the native-vs-web branch only lives
   in one place. result is the raw search-result object (not the JSON-stringified form
   PlayerUiHelper's list rows carry as fileId) - re-stringified here so the native side
   learns which result this was, the same fileId shape PlayerActivity already gets from
   subtitleSearchRequested's own results. Needed so PlayerActivity.currentSubtitleFileId
   gets set on this path too, not just on a manual pick through
   native-bridge.js's subtitleSelectRequested listener. */
async function attachDownloadedSubtitle(controller, text, languageCode, result) {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
        await setNativeSubtitle(text, languageCode, "application/x-subrip");
        await notifyNativeSubtitleApplied(JSON.stringify(result), result.label);
    } else {
        await attachSubtitleTrack(controller, text, languageCode, result.label);
    }
}

/* rowEl gets an inline status update on failure instead of the previous
   console.error-only handling - a swallowed error here looked indistinguishable from
   "the click didn't register" since nothing on screen ever changed. Plex's own download
   is asynchronous (see plex-subtitles.js) so this can take up to ~20s, not the near-
   instant round-trip the direct-OpenSubtitles path (opensubtitles.js) makes. */
async function applySubtitleResult(controller, result, rowEl, collapse) {
    const originalLabel = rowEl?.textContent;
    if (rowEl) {
        rowEl.textContent = result.provider === "opensubtitles" ? "Downloading…" : "Downloading via Plex…";
        rowEl.disabled = true;
    }
    try {
        const { text, languageCode } = await StreamingSubtitles.download(controller._session, result);
        await attachDownloadedSubtitle(controller, text, languageCode, result);
        /* Remembered per-title (ratingKey), not per-session - see subtitle-store.js.
           plex-player.js's applyRememberedSubtitle re-reads this at the start of the
           next session for the same title, so this same result (served from the cache
           subtitle-provider.js's download() already populated above, not a fresh
           network call) auto-reapplies without the user searching/selecting again. */
        subtitleStore.setAppliedSubtitle(controller._session?.ratingKey, result);
        collapse();
    } catch (e) {
        console.error("StreamingPlayer: subtitle download failed -", e);
        if (rowEl) {
            rowEl.disabled = false;
            rowEl.textContent = `${originalLabel} — failed: ${e.message}`;
        }
    }
}

/* Re-attaches whatever subtitle was last applied to this title (if any), without the
   user searching/selecting again - called once per session from plex-player.js right
   after playback actually starts (native or web), since attaching needs a live
   <video>/native player to attach to. download() below is normally served from
   subtitle-provider.js's own cache (subtitle-store.js), not a fresh network call. */
export async function applyRememberedSubtitle(controller) {
    const ratingKey = controller._session?.ratingKey;
    const remembered = subtitleStore.getAppliedSubtitle(ratingKey);
    if (!remembered) return;
    try {
        const { text, languageCode } = await StreamingSubtitles.download(controller._session, remembered);
        await attachDownloadedSubtitle(controller, text, languageCode, remembered);
        /* A fresh apply resets the offset to 0 on both legs (attachSubtitleTrack's own
           reset on web; PlayerActivity.applySubtitle's on native) - this restores
           whatever the user last synced to, only bothering the native bridge when
           there's actually a non-zero offset to restore. */
        const offsetMs = subtitleStore.getAppliedOffsetMs(ratingKey);
        if (offsetMs) {
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
                await setNativeSubtitleOffset(offsetMs);
            } else {
                setSubtitleOffset(controller, offsetMs);
            }
        }
    } catch (e) {
        console.error("StreamingPlayer: failed to reapply remembered subtitle -", e);
    }
}

/* The web/Xbox leg's own "Off" row - Android has its own native equivalent
   (PlayerActivity.clearSubtitleTrack, reachable from PlayerUiHelper's menu; chrome.js's
   whole hamburger UI never renders on Android in the first place, see applySubtitleResult's
   history). Clears both the live <track> and the remembered per-title choice, so this
   title doesn't just come back with a subtitle the next time it plays. */
function removeSubtitleResult(controller, collapse) {
    detachSubtitleTrack(controller);
    subtitleStore.clearAppliedSubtitle(controller._session?.ratingKey);
    collapse();
}

/* Only the web/Xbox leg needs this - <video><track> requires WebVTT, while Android's
   Media3 leg (see applySubtitleResult) hands ExoPlayer the raw .srt URL directly, since
   SubripDecoder parses .srt natively and converting it there would be wasted work.
   Revokes the previous track's blob URL rather than leaking one per search. */
function attachSubtitleTrack(controller, srtText, langCode, label) {
    if (!controller._videoEl) return Promise.resolve();
    if (controller._subtitleTrackUrl) URL.revokeObjectURL(controller._subtitleTrackUrl);
    /* A new subtitle file has its own inherent timing - carrying over the previous
       file's offset would misalign this one from the very first cue. */
    controller._subtitleOffsetMs = 0;
    const vtt = srtToVtt(srtText);
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    controller._subtitleTrackUrl = url;
    controller._videoEl.querySelectorAll("track").forEach((t) => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.srclang = langCode || "en";
    track.label = label || langCode || "Subtitles";
    track.src = url;
    track.default = true;
    controller._videoEl.appendChild(track);
    const textTrack = controller._videoEl.textTracks[0];
    if (!textTrack) return Promise.resolve();
    /* Rendered through a manual overlay instead of native "showing" mode - the shader
       upscaling/Color Boost canvas (shader-pipeline.js) opacity:0's the <video> element
       and paints from the raw decoded frame instead, which never includes the browser's
       own separately-composited caption layer. Native rendering would work whenever
       neither is active and silently vanish the instant either turns on, so this always
       draws cues itself rather than having two divergent code paths depending on
       whatever the shader state happens to be. */
    textTrack.mode = "hidden";
    const overlay = ensureSubtitleOverlay(controller);
    textTrack.addEventListener("cuechange", () => {
        const cues = Array.from(textTrack.activeCues || []);
        overlay.style.display = cues.length ? "block" : "none";
        overlay.innerHTML = cues.map((c) => renderSubtitleCueHtml(c.text)).join("<br>");
    });
    /* The <track> loads/parses its VTT asynchronously - textTrack.cues is still empty
       right after this function returns. A caller applying a remembered sync offset
       immediately afterward (applyRememberedSubtitle) needs the actual cues to exist
       before setSubtitleOffset's shift loop has anything to shift; without this wait,
       that offset silently no-ops (only _subtitleOffsetMs gets set) until some later
       unrelated +/- click re-runs the loop against by-then-loaded cues. */
    return new Promise((resolve) => {
        if (textTrack.cues && textTrack.cues.length) {
            resolve();
            return;
        }
        const done = () => {
            track.removeEventListener("load", done);
            track.removeEventListener("error", done);
            resolve();
        };
        track.addEventListener("load", done, { once: true });
        track.addEventListener("error", done, { once: true });
    });
}

/* Counterpart to attachSubtitleTrack above, used by removeSubtitleResult's "Off" row -
   removes the live <track> and hides the overlay rather than leaving the last cue's
   text stuck on screen with nothing left to clear it. */
function detachSubtitleTrack(controller) {
    if (!controller._videoEl) return;
    controller._videoEl.querySelectorAll("track").forEach((t) => t.remove());
    if (controller._subtitleTrackUrl) {
        URL.revokeObjectURL(controller._subtitleTrackUrl);
        controller._subtitleTrackUrl = null;
    }
    controller._subtitleOffsetMs = 0;
    if (controller._subtitleOverlayEl) {
        controller._subtitleOverlayEl.style.display = "none";
        controller._subtitleOverlayEl.innerHTML = "";
    }
}

/* Escapes everything first (this is untrusted third-party subtitle text), then
   re-enables only the handful of legacy SRT-style styling tags real-world .srt files
   actually carry (b/i/u, plus <font color="...">) - native VTT "showing" mode used to
   render these for free; a plain escape-and-dump would instead print the raw tags as
   literal text (confirmed against a real OpenSubtitles .srt with <font color> lines).
   Anything not matching one of these exact patterns stays escaped/literal rather than
   risking arbitrary HTML/CSS injection from a subtitle file. */
function renderSubtitleCueHtml(text) {
    let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    html = html.replace(/&lt;(\/?)(b|i|u)&gt;/gi, "<$1$2>");
    html = html.replace(/&lt;font color="(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)"&gt;/gi, '<span style="color:$1">');
    html = html.replace(/&lt;\/font&gt;/gi, "</span>");
    return html;
}

/* Lazily created (and reused across subtitle-result picks) rather than built alongside
   the video in web-fallback.js's playWeb - most sessions never touch subtitles at all.
   z-index 10001 matches every other always-on-top-of-the-shader-canvas overlay in this
   chrome (e.g. updateSkipButton) - the canvas itself sits at 10000 (shader-pipeline.js). */
function ensureSubtitleOverlay(controller) {
    if (controller._subtitleOverlayEl) return controller._subtitleOverlayEl;
    const overlay = document.createElement("div");
    overlay.className = "streaming-player-subtitle-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        left: "5%",
        right: "5%",
        bottom: "85px",
        zIndex: "10001",
        textAlign: "center",
        pointerEvents: "none",
        color: "rgba(235,235,235,0.95)",
        fontFamily: '"Roboto", sans-serif',
        fontWeight: "700",
        fontSize: "1.4em",
        lineHeight: "1.3",
        textShadow: "0 2px 6px rgba(0,0,0,0.85)",
        display: "none",
    });
    document.body.appendChild(overlay);
    controller._subtitleOverlayEl = overlay;
    return overlay;
}

function srtToVtt(srtText) {
    return "WEBVTT\n\n" + srtText.replace(/\r+/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
}
