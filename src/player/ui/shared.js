export const CONTROLS_HIDE_DELAY_MS = 1000;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
export const ZOOM_LEVELS = [1, 1.25, 1.5, 2];
export const VOLUME_STORAGE_KEY = "prism_player_volume";
export const AMBIENT_STORAGE_KEY = "prism_player_ambient_enabled";
export const AMBIENT_OPACITY_STORAGE_KEY = "prism_player_ambient_opacity";
export const COLOR_BOOST_STORAGE_KEY = "prism_player_color_boost_enabled";
export const COLOR_BOOST_STRENGTH_STORAGE_KEY = "prism_player_color_boost_strength";
export const STATS_OVERLAY_STORAGE_KEY = "prism_player_stats_overlay_enabled";

export function storedVolume() {
    const raw = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
}

/* Unlike shader upscaling's upscale_enabled (a Settings-modal default the in-player
   toggle only ever overrides for the current session, see shader-pipeline.js), ambient
   lighting has no per-video auto-detected type to reconcile against - the in-player
   toggle IS the setting, written here the moment it's flipped (see setAmbientEnabled)
   and read back for every subsequent video, the same immediate-persistence model as
   VOLUME_STORAGE_KEY above. */
export function storedAmbientEnabled() {
    return localStorage.getItem(AMBIENT_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedAmbientEnabled above, not the Settings-modal
   tiered-preset model shader strength uses (see ambient-pipeline.js's setAmbientOpacity)
   - opacity has no per-video/genre concern to reconcile either. */
export function storedAmbientOpacity() {
    const raw = Number(localStorage.getItem(AMBIENT_OPACITY_STORAGE_KEY));
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/* Same immediate-persistence model as storedAmbientEnabled - Color Boost (contrast/
   saturation) has no per-video/genre concern to reconcile against either, unlike shader
   upscaling's Settings-modal-default-plus-session-override model. */
export function storedColorBoostEnabled() {
    return localStorage.getItem(COLOR_BOOST_STORAGE_KEY) === "1";
}

export function storedColorBoostStrength() {
    const raw = Number(localStorage.getItem(COLOR_BOOST_STRENGTH_STORAGE_KEY));
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/* Same immediate-persistence model as storedAmbientEnabled - a debug readout has no
   per-video/genre concern to reconcile either. */
export function storedStatsOverlayEnabled() {
    return localStorage.getItem(STATS_OVERLAY_STORAGE_KEY) === "1";
}

/* Drawn as an inline SVG using currentColor rather than a "🔊"/"🔉"/"🔇" emoji glyph -
   those Unicode code points have default emoji presentation on every platform this app
   targets, so they render as full-color pictures the CSS `color` on the button can never
   touch (same font-glyph-rendering problem the Android leg's PlayPauseIconView/
   ChapterSkipIconView already work around by drawing their icons instead of using a
   glyph). */
export function volumeIconMarkup(level) {
    const speaker = '<path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>';
    const waveNear = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" fill="currentColor"/>';
    const waveFar =
        '<path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="currentColor"/>';
    const muteSlash = '<line x1="16" y1="7" x2="22" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    let inner = speaker;
    if (level <= 0) inner += muteSlash;
    else if (level < 0.5) inner += waveNear;
    else inner += waveNear + waveFar;
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/* Same currentColor-SVG reasoning as volumeIconMarkup above - a circular arrow drawn
   from scratch rather than "⏪"/"⏩" glyphs, which have the same fixed-color emoji-
   presentation problem. "back"/"forward" mirror the same arc+arrowhead across the
   vertical axis (opposite sweep direction, opposite arrowhead) while the "5" label stays
   unmirrored in both, matching the skip-5s convention HBO's own player uses.

   The arc's start/end points are placed exactly on the radius-8 circle centered at
   (12,12) (12,4 is 8px straight up from center; the two arcEnd values are that same
   circle's point near the bottom-left/bottom-right) - an earlier version used a start
   point that was only 7px from center, so the actual circle SVG solved for to pass
   through both mismatched points was centered somewhere else entirely and swung outside
   the 0-24 viewBox, clipping visibly (SVG's default overflow:hidden crops anything
   outside it). The viewBox itself still carries a few px of padding beyond that on top,
   as a margin against exactly this kind of arc-math mistake recurring unnoticed. */
export function seekIconMarkup(direction) {
    const sweepFlag = direction === "forward" ? 0 : 1;
    const arcEnd = direction === "forward" ? "6.2 17.5" : "17.8 17.5";
    const arrowhead = direction === "forward" ? "15,1 15,7 9,4" : "9,1 9,7 15,4";
    const arc = `<path d="M12 4 A8 8 0 1 ${sweepFlag} ${arcEnd}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
    const arrow = `<polygon points="${arrowhead}" fill="currentColor"/>`;
    const label = `<text x="12" y="16.5" font-size="7.5" font-weight="700" text-anchor="middle" font-family="Roboto, sans-serif" fill="currentColor">5</text>`;
    return `<svg viewBox="-6 -6 36 36" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">${arc}${arrow}${label}</svg>`;
}
