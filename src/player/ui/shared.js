export const CONTROLS_HIDE_DELAY_MS = 1000;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
export const ZOOM_LEVELS = [1, 1.25, 1.5, 2];
export const VOLUME_STORAGE_KEY = "prism_player_volume";

export function storedVolume() {
    const raw = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
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
