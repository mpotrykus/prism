export const CONTROLS_HIDE_DELAY_MS = 1000;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
export const ZOOM_LEVELS = [1, 1.25, 1.5, 2];
/* kbps: null means "no cap" (Original) - matched against the selected quality cap by
   identity in chrome.js's openQualityCapMenu, so keep it null rather than 0 or a
   sentinel number. */
export const QUALITY_CAP_PRESETS = [
    { label: "Original", kbps: null },
    { label: "1080p (20 Mbps)", kbps: 20000 },
    { label: "720p (10 Mbps)", kbps: 10000 },
    { label: "480p (4 Mbps)", kbps: 4000 },
    { label: "360p (2 Mbps)", kbps: 2000 },
];
export const VOLUME_STORAGE_KEY = "prism_player_volume";
export const AMBIENT_STORAGE_KEY = "prism_player_ambient_enabled";
export const AMBIENT_OPACITY_STORAGE_KEY = "prism_player_ambient_opacity";
export const UPSCALE_ENABLED_STORAGE_KEY = "prism_player_upscale_enabled";
export const UPSCALE_STRENGTH_STORAGE_KEY = "prism_player_upscale_strength";
export const UPSCALE_AUTO_STORAGE_KEY = "prism_player_upscale_auto";
export const COLOR_BOOST_STORAGE_KEY = "prism_player_color_boost_enabled";
export const COLOR_BOOST_STRENGTH_STORAGE_KEY = "prism_player_color_boost_strength";
export const COLOR_BOOST_AUTO_STORAGE_KEY = "prism_player_color_boost_auto";
export const STATS_OVERLAY_STORAGE_KEY = "prism_player_stats_overlay_enabled";
export const AUTO_PLAY_STORAGE_KEY = "prism_player_auto_play_enabled";
export const AUTO_QUALITY_STORAGE_KEY = "prism_player_auto_quality_enabled";

export function storedVolume() {
    const raw = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
}

/* The in-player toggle IS the setting, written here the moment it's flipped (see
   setAmbientEnabled) and read back for every subsequent video, same immediate-
   persistence model as VOLUME_STORAGE_KEY above - no Settings-modal default to reconcile
   against. */
export function storedAmbientEnabled() {
    return localStorage.getItem(AMBIENT_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedAmbientEnabled above - opacity has no
   per-video/genre concern to reconcile either. The explicit `stored !== null` check
   matters: Number(null) is 0, not NaN, which would otherwise pass the >= 0 check below
   and silently make "never set" indistinguishable from "explicitly set to 0" - every
   fresh session would start at 0% (invisible) instead of the intended 50% default. */
export function storedAmbientOpacity() {
    const stored = localStorage.getItem(AMBIENT_OPACITY_STORAGE_KEY);
    const raw = Number(stored);
    return stored !== null && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/* Same immediate-persistence model as storedAmbientEnabled - whatever the in-player
   Shader Upscaling toggle was last set to (see shader-pipeline.js's setShaderEnabled),
   not a Settings-modal default reset every video. detectShaderType's own per-video genre
   detection is unrelated to this and still resolves fresh every time (see
   plex-player.js's play()). */
export function storedShaderEnabled() {
    return localStorage.getItem(UPSCALE_ENABLED_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedShaderEnabled above. 0.65 (not documented
   anywhere else now) was "Medium"'s value back when this was a Settings-modal preset
   dropdown (light/medium/strong) rather than a raw persisted slider position - kept as
   the default for a first-ever session, same reasoning storedColorBoostStrength's own
   0.5 default follows. Same `stored !== null` reasoning as storedAmbientOpacity above -
   without it, a never-set key silently defaults to strength 0 instead of 0.65 (Number(null)
   is 0, not NaN), which combined with setUpscaleAuto not re-resolving _shaderType made
   Auto mode look permanently stuck at 0% for anyone who'd never touched the manual
   slider. */
export function storedShaderStrength() {
    const stored = localStorage.getItem(UPSCALE_STRENGTH_STORAGE_KEY);
    const raw = Number(stored);
    return stored !== null && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.65;
}

/* Same immediate-persistence model as storedShaderEnabled above. The resolved auto
   strength itself is never persisted, only this flag - see shader-pipeline.js's
   renderShaderFrame. */
export function storedUpscaleAuto() {
    return localStorage.getItem(UPSCALE_AUTO_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedAmbientEnabled - Color Boost (contrast/
   saturation) has no per-video/genre concern to reconcile against either. */
export function storedColorBoostEnabled() {
    return localStorage.getItem(COLOR_BOOST_STORAGE_KEY) === "1";
}

/* Same `stored !== null` reasoning as storedAmbientOpacity/storedShaderStrength above. */
export function storedColorBoostStrength() {
    const stored = localStorage.getItem(COLOR_BOOST_STRENGTH_STORAGE_KEY);
    const raw = Number(stored);
    return stored !== null && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/* Same immediate-persistence model as storedColorBoostEnabled/storedUpscaleAuto above -
   the resolved auto strength itself is never persisted, only this flag - see
   shader-pipeline.js's renderShaderFrame. */
export function storedColorBoostAuto() {
    return localStorage.getItem(COLOR_BOOST_AUTO_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedAmbientEnabled - a debug readout has no
   per-video/genre concern to reconcile either. */
export function storedStatsOverlayEnabled() {
    return localStorage.getItem(STATS_OVERLAY_STORAGE_KEY) === "1";
}

/* Same immediate-persistence model as storedStatsOverlayEnabled - no per-video/genre
   concern, whatever this was last toggled to is what every subsequent session starts
   from. Defaults to on (unlike every other toggle here, which defaults off) for a user
   who's never touched this setting at all - a bare-missing key, not an explicit "0". */
export function storedAutoPlayEnabled() {
    const stored = localStorage.getItem(AUTO_PLAY_STORAGE_KEY);
    return stored === null ? true : stored === "1";
}

/* Unlike storedAutoPlayEnabled, this does NOT default on for a never-touched user -
   every Auto Quality step (up or down) is a real server-side transcode restart (see
   core/abr.js), not a free/seamless adjustment, so a user who's never opted in
   shouldn't have Plex silently re-transcoding their stream. */
export function storedAutoQualityEnabled() {
    return localStorage.getItem(AUTO_QUALITY_STORAGE_KEY) === "1";
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

/* Same currentColor-SVG reasoning as volumeIconMarkup/seekIconMarkup above, and shared
   by both the chapter-nav and title-nav buttons (see chrome.js's makeChapterNavButton/
   makeTitleNavButton) so the two read as one consistent icon family instead of two
   differently-rendered "⏮"/"⏭"-style glyphs - only the triangle count (double for
   chapter, single for title) tells them apart. Built once in the "next" (rightward)
   orientation and mirrored via an SVG transform for "prev", so the two directions can't
   drift out of sync with each other. */
export function skipIconMarkup(direction, { double = false } = {}) {
    const bar = '<rect x="16.6" y="5" width="2.2" height="14" rx="0.6" fill="currentColor"/>';
    const nearTriangle = '<polygon points="8,5 8,19 16.2,12" fill="currentColor"/>';
    const farTriangle = double ? '<polygon points="0.4,5 0.4,19 8.6,12" fill="currentColor"/>' : "";
    const mirror = direction === "prev" ? ' transform="translate(24,0) scale(-1,1)"' : "";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><g${mirror}>${farTriangle}${nearTriangle}${bar}</g></svg>`;
}

/* Same currentColor-SVG reasoning as volumeIconMarkup/seekIconMarkup above - the
   standard four-corner-bracket "expand"/"contract" glyph pair, swapped on
   fullscreenchange rather than drawn once. */
export function fullscreenIconMarkup(isFullscreen) {
    const path = isFullscreen
        ? "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
        : "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`;
}

/* Same currentColor-SVG reasoning as volumeIconMarkup/fullscreenIconMarkup above - a
   classic closed-captions glyph (rounded outline rect + two text-line bars) for the
   transport bar's Audio & Subtitles button (see buildTransportBar's rightCell), which
   opens openAudioSubtitlesOverlay directly rather than living in the More menu.
   Geometry mirrors Android's MenuIconView.Icon.SUBTITLES exactly (same 24x24 box) so
   the two platforms read as the same icon. */
export function audioSubtitlesIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><rect x="5" y="9" width="10" height="2" rx="1" fill="currentColor"/><rect x="5" y="13" width="6" height="2" rx="1" fill="currentColor"/></svg>';
}

/* Icons for each row of the More menu (chrome.js's buildAccordionRow/renderPickerRows
   callers) - one markup function per row, same currentColor-SVG-not-emoji reasoning as
   every icon above. A handful of rows deliberately reuse an existing markup above
   rather than getting their own (Auto-Play reuses skipIconMarkup's "next" glyph, Shader
   Upscaling reuses fullscreenIconMarkup's expand glyph) since those already draw the
   right concept - see openHamburgerMenu/renderEffectsList/renderExtrasList in chrome.js
   for where each one is actually wired up. Android's MenuIconView mirrors this same set
   of shapes so the two platforms read as one icon family. */
export function chaptersIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6 2h12v19l-6-4-6 4V2z"/></svg>';
}

export function versionIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
        <polygon points="12,3 21,8 12,13 3,8"/>
        <polyline points="3,12 12,17 21,12"/>
        <polyline points="3,16 12,21 21,16"/>
    </svg>`;
}

export function qualityCapIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="14" width="4" height="7" rx="1"/>
        <rect x="10" y="9" width="4" height="12" rx="1"/>
        <rect x="17" y="4" width="4" height="17" rx="1"/>
    </svg>`;
}

export function effectsIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.2 6.2L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.8L12 2z"/></svg>';
}

export function extrasIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <line x1="4" y1="6" x2="20" y2="6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="9" cy="6" r="2.2" fill="currentColor"/>
        <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="15" cy="12" r="2.2" fill="currentColor"/>
        <line x1="4" y1="18" x2="20" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="11" cy="18" r="2.2" fill="currentColor"/>
    </svg>`;
}

export function performanceIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="2,14 7,14 10,6 14,18 17,10 22,10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export function colorBoostIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/>
        <path d="M12 3a9 9 0 010 18z" fill="currentColor"/>
    </svg>`;
}

export function ambientIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="4.5" fill="currentColor"/>
        <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="12" y1="1" x2="12" y2="4"/>
            <line x1="12" y1="20" x2="12" y2="23"/>
            <line x1="1" y1="12" x2="4" y2="12"/>
            <line x1="20" y1="12" x2="23" y2="12"/>
            <line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/>
            <line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/>
            <line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/>
            <line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/>
        </g>
    </svg>`;
}

export function speedIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 18a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="12" y1="18" x2="16" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="12" cy="18" r="1.4" fill="currentColor"/>
    </svg>`;
}

export function zoomIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.8"/>
        <line x1="15.3" y1="15.3" x2="21" y2="21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
}

export function sleepIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
}
