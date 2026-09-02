import { hasNativePlayer } from "../core/platform.js";
import { wireLinearNav, focusAfterPaint } from "../../core/focus-nav.js";
import { media } from "../core/media-facade.js";
import { parseSubtitleCues, activeCuesAt } from "../core/subtitle-cues.js";
import * as StreamingSubtitles from "../core/subtitle-provider.js";
import * as subtitleStore from "../core/subtitle-store.js";
import { trySwitchAudioTrackLocal } from "../web-fallback.js";
import { trySwitchAudioTrackLocallyXbox } from "../xbox-bridge.js";
import { setNativeSubtitle, setNativeSubtitleOffset, notifyNativeSubtitleApplied } from "../native-bridge.js";
import { hideControls, showControls } from "./chrome-controls.js";
import { closeInlineMenu, renderPickerList } from "./chrome-menu.js";

/* Audio Track/Subtitles picker (its own right-anchored overlay, opened from the More menu's
   "Audio & Subtitles" row - see chrome-menu.js's renderMainList) plus everything about
   attaching/offsetting/rendering a subtitle track on the web/Xbox <video> leg. Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state.

   Circular with web-fallback.js (which imports closeAudioSubtitlesOverlay from this file)
   and with chrome-menu.js (which imports openAudioSubtitlesOverlay from this file, while
   this file imports closeInlineMenu/renderPickerList from chrome-menu.js) - safe here for
   the same reason documented in web-fallback.js's own header comment: every cross-reference
   is only ever called from inside a click handler/`nav` callback, never at module-top-level
   evaluation time. */

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
               didn't produce one EXT-X-MEDIA rendition per audio stream). Xbox has no
               hls.js object at all, so trySwitchAudioTrackLocal always bails out (0) for
               it - trySwitchAudioTrackLocallyXbox is Xbox's own equivalent, only for a
               direct-played title (see its own header comment). */
            if (!trySwitchAudioTrackLocal(controller, stream.id) && !trySwitchAudioTrackLocallyXbox(controller, stream.id)) {
                controller._reloadSource({ audioStreamID: stream.id });
            }
            setValue(stream.label);
            collapse();
            /* _reloadSource updates controller._session.audioStreamId synchronously,
               but this picker list was already built above with the old `current` -
               re-render in place so the ✓ moves to the new selection immediately
               instead of only after the overlay/menu is closed and reopened. */
            renderAudioSection(controller, content, { setValue, collapse });
            /* content.innerHTML="" above just destroyed the button the viewer had focus on to
               build fresh ones - left alone, focus falls to <body> and the whole overlay stops
               responding to any further D-pad/keyboard command, including Back (same bug and fix
               as chrome-menu.js's refocusList/buildAccordionRow's collapse). */
            focusAfterPaint(content.querySelector("button"));
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
    scrim.className = "prism-player-scrim";
    scrim.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));

    const panel = document.createElement("div");
    panel.className = "prism-player-as-panel";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.classList.add("prism-player-focusable", "prism-player-overlay-close", "prism-player-as-close");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));
    panel.appendChild(closeBtn);

    /* Audio first (left), Subtitles second (right). Each column caps its own list at a
       fixed max-height and scrolls independently rather than the two needing to match
       heights exactly (unlike this control's previous top/bottom-split incarnation,
       nothing here requires the two columns to be the same height). */
    const grid = document.createElement("div");
    grid.className = "prism-player-as-grid";

    const audioColumn = buildAudioSubtitlesColumn("Audio");
    /* One data-nav-group per column (read by focus-nav.js's groupOf via closest(), not set
       on each individual row) - so Left/Right jumps between the Audio and Subtitles columns
       instead of Up/Down treating both columns as one flat vertical list, matching how the
       two actually sit side by side. Covers rows added later by a re-render (renderAudioSection's
       own re-render on select, subtitle search results) for free since it's on the container. */
    audioColumn.el.dataset.navGroup = "audio-subtitles-audio";
    renderAudioSection(controller, audioColumn.body, { setValue: () => {}, collapse: () => {} });
    grid.appendChild(audioColumn.el);

    const subtitlesColumn = buildAudioSubtitlesColumn("Subtitles");
    subtitlesColumn.el.dataset.navGroup = "audio-subtitles-subtitles";
    renderSubtitleSection(controller, subtitlesColumn.body, { collapse: () => closeAudioSubtitlesOverlay(controller) });
    grid.appendChild(subtitlesColumn.el);

    panel.appendChild(grid);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._audioSubtitlesEl = { scrim, panel };
    /* Gamepad navigation for this overlay. `document` is the root rather than the panel because
       wireLinearNav reads root.activeElement, which only exists on Document/ShadowRoot - a plain
       <div> reports undefined and the handler would never consider itself in scope. focusFirst() is
       required: the handler ignores every command until focus is already inside its own list. */
    const nav = wireLinearNav(document, '.prism-player-as-panel input, .prism-player-as-panel button:not(.prism-player-overlay-close)', {
        orientation: "horizontal",
        loop: true,
        onBack: () => closeAudioSubtitlesOverlay(controller),
    });
    nav.focusFirst();
    controller._audioSubtitlesNav = nav;
    hideControls(controller);
    requestAnimationFrame(() => {
        panel.classList.add("is-open");
    });
}

export function closeAudioSubtitlesOverlay(controller) {
    if (controller._audioSubtitlesNav) {
        controller._audioSubtitlesNav.destroy();
        controller._audioSubtitlesNav = null;
    }
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
    el.className = "prism-player-as-column";

    const heading = document.createElement("div");
    heading.className = "prism-player-as-heading";
    heading.textContent = title;
    el.appendChild(heading);

    const body = document.createElement("div");
    body.className = "prism-player-scroll prism-player-as-body";
    el.appendChild(body);

    return { el, body };
}

/* session.title is the show name (not the episode title) once an episode is playing -
   see title-fetch.js's grandparentTitle fallback - so a plain title search returns every
   episode's subtitles. Appending "S01E01" (the naming convention subtitle releases
   actually use) narrows a free-text provider search to the one episode. */
function defaultSubtitleSearchQuery(session) {
    if (!session) return "";
    if (session.seasonNumber == null || session.episodeNumber == null) return session.title || "";
    const season = String(session.seasonNumber).padStart(2, "0");
    const episode = String(session.episodeNumber).padStart(2, "0");
    return `${session.title || ""} S${season}E${episode}`.trim();
}

/* Lives in the player chrome, not the title-info modal - subtitle search is
   realistically a mid-playback action ("I'm already watching, there's no subs, let me
   search") more than a pre-playback picker step. */
function renderSubtitleSection(controller, content, { collapse }) {
    const input = document.createElement("input");
    input.type = "text";
    input.classList.add("prism-player-focusable", "prism-player-as-field");
    input.placeholder = "Search subtitles…";
    input.value = defaultSubtitleSearchQuery(controller._session);

    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.classList.add("prism-player-focusable", "prism-player-as-btn");
    searchBtn.textContent = "Search";

    /* flex:1 1 auto/minHeight:0 fills exactly whatever height is left in the parent
       column after the heading/input/button above (see buildAudioSubtitlesColumn) -
       the one and only scroll region for this column, not a second fixed-height
       (previously 260px) scroller nested inside that column's own. */
    const resultsEl = document.createElement("div");
    resultsEl.className = "prism-player-scroll prism-player-as-results";

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
                row.classList.add("prism-player-focusable", "prism-player-menu-row", "prism-player-as-result-row");
                const isApplied = subtitleStore.isAppliedResult(appliedRatingKey, r);
                row.textContent = `${r.label} (${r.languageCode})${isApplied ? "  ✓" : ""}`;
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
    if (hasSubtitleTrack(controller)) {
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
    row.className = "prism-player-as-sync-row";

    const label = document.createElement("span");
    label.className = "prism-player-as-sync-label";
    const renderLabel = () => {
        const ms = controller._subtitleOffsetMs || 0;
        label.textContent = `Sync: ${ms > 0 ? "+" : ""}${ms}ms`;
    };
    renderLabel();

    const makeStepBtn = (glyph, delta) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add("prism-player-focusable", "prism-player-as-step-btn");
        btn.textContent = glyph;
        btn.setAttribute("aria-label", delta < 0 ? "Subtitles earlier" : "Subtitles later");
        btn.addEventListener("click", () => {
            adjustSubtitleOffset(controller, delta);
            renderLabel();
        });
        return btn;
    };

    const buttons = document.createElement("div");
    buttons.className = "prism-player-as-sync-buttons";
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
    btn.classList.add("prism-player-focusable", "prism-player-as-btn", "prism-player-as-btn--ghost");
    btn.textContent = "Off";
    btn.addEventListener("click", () => removeSubtitleResult(controller, collapse));
    return btn;
}

/* Just records the offset - activeCuesAt applies it when looking up what's on screen, so
   there are no already-parsed cue times to mutate and no dependency on the track having
   finished loading. _subtitleRenderedKey is cleared so the next rAF tick repaints even if
   the active cue set happens to be unchanged by the shift.

   Absolute rather than a delta so applyRememberedSubtitle below can restore a
   previously-saved offset in one call, the same function the +/- buttons use. */
function setSubtitleOffset(controller, offsetMs) {
    controller._subtitleOffsetMs = offsetMs;
    controller._subtitleRenderedKey = null;
    renderSubtitleFrame(controller);
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
   player.js at the start of every session) so the native-vs-web branch only lives
   in one place. result is the raw search-result object (not the JSON-stringified form
   PlayerUiHelper's list rows carry as fileId) - re-stringified here so the native side
   learns which result this was, the same fileId shape PlayerActivity already gets from
   subtitleSearchRequested's own results. Needed so PlayerActivity.currentSubtitleFileId
   gets set on this path too, not just on a manual pick through
   native-bridge.js's subtitleSelectRequested listener. */
async function attachDownloadedSubtitle(controller, text, languageCode, result) {
    if (hasNativePlayer()) {
        await setNativeSubtitle(text, languageCode, "application/x-subrip");
        await notifyNativeSubtitleApplied(JSON.stringify(result), result.label);
    } else {
        await attachSubtitleTrack(controller, text);
    }
}

/* rowEl gets an inline status update on failure instead of the previous
   console.error-only handling - a swallowed error here looked indistinguishable from
   "the click didn't register" since nothing on screen ever changed. Plex's own download
   is asynchronous (see plex/subtitles.js) so this can take up to ~20s, not the near-
   instant round-trip the direct-OpenSubtitles path (opensubtitles.js) makes.

   Guards re-entry via a dataset flag rather than rowEl.disabled - this row holds real
   D-pad focus (it was just "activated" to get here), and disabling a focused element
   makes the browser blur it to <body> immediately. <body> isn't in this overlay's
   wireLinearNav list, so every command - including Back - silently stops working for
   the rest of the overlay. Confirmed on real Xbox hardware: with no rebuild/re-render on
   failure to trigger some other refocus, that left the controller with no way out short
   of closing the app. Never disabling rowEl means it never loses focus in the first
   place, so there's nothing to restore. */
async function applySubtitleResult(controller, result, rowEl, collapse) {
    if (rowEl?.dataset.busy === "1") return;
    const originalLabel = rowEl?.textContent;
    if (rowEl) {
        rowEl.dataset.busy = "1";
        rowEl.textContent = result.provider === "opensubtitles" ? "Downloading…" : "Downloading via Plex…";
    }
    try {
        const { text, languageCode } = await StreamingSubtitles.download(controller._session, result);
        await attachDownloadedSubtitle(controller, text, languageCode, result);
        /* Remembered per-title (ratingKey), not per-session - see subtitle-store.js.
           player.js's applyRememberedSubtitle re-reads this at the start of the
           next session for the same title, so this same result (served from the cache
           subtitle-provider.js's download() already populated above, not a fresh
           network call) auto-reapplies without the user searching/selecting again. */
        subtitleStore.setAppliedSubtitle(controller._session?.ratingKey, result);
        collapse();
    } catch (e) {
        console.error("StreamingPlayer: subtitle download failed -", e);
        if (rowEl) {
            rowEl.dataset.busy = "0";
            rowEl.textContent = `${originalLabel} — failed: ${e.message}`;
        }
    }
}

/* Re-attaches whatever subtitle was last applied to this title (if any), without the
   user searching/selecting again - called once per session from player.js right
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
            if (hasNativePlayer()) {
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

/* Only the non-Android leg needs this - Android's Media3 leg (see applySubtitleResult)
   hands ExoPlayer the raw .srt text directly, since SubripDecoder parses it natively.

   Cues are parsed into plain objects (core/subtitle-cues.js) and drawn by this module's
   own rAF loop off the current playback position, rather than going through a WebVTT blob
   URL attached as a <video><track> and driven by the browser's `cuechange` event. See
   subtitle-cues.js's header for why: a <track> needs a real <video> element (the Xbox
   shell's native player has none), and a sync offset used to require mutating already-
   parsed cue times, which is what forced this function to return a load promise so a
   remembered offset applied right afterward had cues to shift. Neither applies now.

   The language code and label the caller has are deliberately not taken: they only ever fed
   the <track> element's srclang/label attributes, which existed for a browser caption menu
   this player never exposes (the <video> runs with controls = false). The remembered result
   object in subtitle-store.js is what carries the label the UI actually shows. */
function attachSubtitleTrack(controller, srtText) {
    /* Nothing to render against yet - same guard as the old `!controller._videoEl`, but on
       the facade, since a native backend has no element. */
    if (!media(controller)) return Promise.resolve();
    /* A new subtitle file has its own inherent timing - carrying over the previous
       file's offset would misalign this one from the very first cue. */
    controller._subtitleOffsetMs = 0;
    controller._subtitleCues = parseSubtitleCues(srtText);
    controller._subtitleRenderedKey = null;
    ensureSubtitleOverlay(controller);
    startSubtitleLoop(controller);
    return Promise.resolve();
}

/* Counterpart to attachSubtitleTrack above, used by removeSubtitleResult's "Off" row -
   drops the cues and hides the overlay rather than leaving the last cue's text stuck on
   screen with nothing left to clear it. */
function detachSubtitleTrack(controller) {
    stopSubtitleLoop(controller);
    controller._subtitleCues = null;
    controller._subtitleRenderedKey = null;
    controller._subtitleOffsetMs = 0;
    if (controller._subtitleOverlayEl) {
        controller._subtitleOverlayEl.classList.remove("is-showing");
        controller._subtitleOverlayEl.innerHTML = "";
    }
}

/* True once a subtitle is attached - what the Sync/Off rows key off instead of probing
   controller._videoEl.textTracks[0], which no longer exists. */
function hasSubtitleTrack(controller) {
    return !!controller._subtitleCues?.length;
}

/* rAF rather than the <video>'s own `timeupdate` (which only fires ~4x/second, enough to
   put a cue up to ~250ms late) or a fixed interval. The DOM write is guarded by a key
   built from the active cue set, so a normal frame costs one activeCuesAt scan and a
   string compare - innerHTML is only touched when what's on screen actually changes. */
function renderSubtitleFrame(controller) {
    const overlay = controller._subtitleOverlayEl;
    const cues = controller._subtitleCues;
    if (!overlay || !cues?.length) return;
    const positionMs = (media(controller)?.currentTime ?? 0) * 1000;
    const active = activeCuesAt(cues, positionMs, controller._subtitleOffsetMs || 0);
    const key = active.map((c) => c.startMs).join(",");
    if (key === controller._subtitleRenderedKey) return;
    controller._subtitleRenderedKey = key;
    overlay.classList.toggle("is-showing", active.length > 0);
    overlay.innerHTML = active.map((c) => renderSubtitleCueHtml(c.text)).join("<br>");
}

function startSubtitleLoop(controller) {
    if (controller._subtitleRafId) return;
    const tick = () => {
        controller._subtitleRafId = requestAnimationFrame(tick);
        renderSubtitleFrame(controller);
    };
    controller._subtitleRafId = requestAnimationFrame(tick);
}

export function stopSubtitleLoop(controller) {
    if (controller._subtitleRafId) {
        cancelAnimationFrame(controller._subtitleRafId);
        controller._subtitleRafId = null;
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
   chrome (e.g. updateSkipButton) - the canvas itself sits at 10000 (shader-pipeline.js).

   Cues are drawn into this overlay rather than letting the browser render them natively
   (a <track> in "showing" mode): the shader upscaling/Color Boost canvas
   (shader-pipeline.js) opacity:0's the <video> element and paints from the raw decoded
   frame instead, which never includes the browser's separately-composited caption layer.
   Native rendering would work whenever neither effect is active and silently vanish the
   instant either turned on. */
function ensureSubtitleOverlay(controller) {
    if (controller._subtitleOverlayEl) return controller._subtitleOverlayEl;
    const overlay = document.createElement("div");
    overlay.className = "prism-player-subtitles";
    document.body.appendChild(overlay);
    controller._subtitleOverlayEl = overlay;
    return overlay;
}

