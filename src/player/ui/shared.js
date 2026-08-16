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
/* Full-height right-side drawer gradient shared by both chrome-menu.js's hamburger sheet
   and chrome-subtitles.js's Audio & Subtitles panel - same fade-from-the-right look, just
   different panel widths. */
export const SHEET_GRADIENT = "linear-gradient(to left, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5) 85%, transparent 100%)";

export const MENU_SCROLL_CLASS = "streaming-player-menu-scroll";

/* Marks every player overlay's "✕" close button (the hamburger sheet, Audio & Subtitles,
   Episode list, Chapter list) - each overlay's own wireLinearNav call excludes this class
   from its selector, since B/Escape already closes the same overlay and a D-pad/keyboard
   user reaching a redundant close button mid-list would be an odd, easy-to-hit dead end
   between whatever's actually selectable on either side of it. Mouse/touch users still
   click it directly; nothing here removes the button itself, only D-pad/keyboard's own
   path to it. */
export const OVERLAY_CLOSE_BTN_CLASS = "streaming-player-overlay-close-btn";

/* Marks every focusable/selectable element in the player's own chrome (corner buttons, the
   floating play button, every hamburger/Effects/Extras/Audio & Subtitles/Episode/Chapter row
   and card) so they all share one focus-ring look - the same 2px solid #e5a00d outline the
   main browsing UI uses (see src/card/styles/shared-focus.css), rather than the player
   inventing its own. This chrome lives in plain document.body, not a shadow root, so unlike
   that file's own explicit per-component selector list, one shared class is what scopes this
   rule to player elements only, applied at the point each button/card is built - see
   ensurePlayerFocusStyle below. border-radius is new here (shared-focus.css doesn't need one:
   every element it lists already has its own rounded shape - a poster, a pill, a circular
   button); most of this chrome's rows/buttons are plain rectangles with no radius of their
   own, so the ring would otherwise render square-cornered. Inline styles still win over this
   class for anything that sets its own border-radius (the circular corner/play buttons), so
   this only rounds elements that didn't already have an opinion. */
export const PLAYER_FOCUSABLE_CLASS = "streaming-player-focusable";

/* Injected once, lazily, the same guarded pattern as ensureMenuScrollStyle below - nothing
   needs this until the first focusable element actually mounts. */
export function ensurePlayerFocusStyle() {
    if (document.getElementById("streaming-player-focusable-style")) return;
    const style = document.createElement("style");
    style.id = "streaming-player-focusable-style";
    style.textContent = `
        .${PLAYER_FOCUSABLE_CLASS} {
            outline: 2px solid #e5a00d00;
            outline-offset: 2px;
            border-radius: 8px;
            transition: .125s;
        }
        .${PLAYER_FOCUSABLE_CLASS}:focus-visible {
            outline: 2px solid #e5a00d;
        }
    `;
    document.head.appendChild(style);
}

/* Hides the scrollbar for any flyout content that overflows (subtitle search results,
   a long chapter/audio-track list) instead of the browser's default wide scrollbar
   clashing with the glass-panel look above. Injected once, lazily, rather than at
   module load - nothing needs it until a panel actually overflows. Shared by
   chrome-menu.js and chrome-subtitles.js so both panels use the exact same scrollbar
   styling instead of each carrying its own copy. */
export function ensureMenuScrollStyle() {
    if (document.getElementById("streaming-player-menu-scroll-style")) return;
    const style = document.createElement("style");
    style.id = "streaming-player-menu-scroll-style";
    style.textContent = `
        .${MENU_SCROLL_CLASS} { scrollbar-width: none; }
        .${MENU_SCROLL_CLASS}::-webkit-scrollbar { display: none; width: 0; height: 0; }
    `;
    document.head.appendChild(style);
}

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
   unmirrored in both, matching the skip-5s convention HBO's own player uses. */
export function seekIconMarkup(direction) {
    const sweepFlag = direction === "forward" ? 0 : 1;
    const arcEnd = direction === "forward" ? "6.2 17.5" : "17.8 17.5";
    const arrowhead = direction === "forward" ? "15,1 15,7 9,4" : "9,1 9,7 15,4";
    const arc = `<path d="M12 4 A8 8 0 1 ${sweepFlag} ${arcEnd}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
    const arrow = `<polygon points="${arrowhead}" fill="currentColor"/>`;
    const label = `<text x="12" y="16.5" font-size="7.5" font-weight="700" text-anchor="middle" font-family="Roboto, sans-serif" fill="currentColor">5</text>`;
    return `<svg viewBox="-6 -6 36 36" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">${arc}${arrow}${label}</svg>`;
}

/* Same currentColor-SVG reasoning as audioSubtitlesIconMarkup below - drawn from scratch
   rather than an "⏮"/"⏭" glyph, which has the same fixed-color emoji-presentation problem.
   Shared by chrome-menu.js's Auto-Play row (single triangle) and chrome-transport.js's
   web-only chapter/title-nav transport buttons (double triangle, see platformTag() !== "xbox"
   gating in buildCenterControls) - the `double` option tells the two uses apart. */
export function skipIconMarkup(direction, { double = false } = {}) {
    const bar = '<rect x="16.6" y="5" width="2.2" height="14" rx="0.6" fill="currentColor"/>';
    const nearTriangle = '<polygon points="8,5 8,19 16.2,12" fill="currentColor"/>';
    const farTriangle = double ? '<polygon points="0.4,5 0.4,19 8.6,12" fill="currentColor"/>' : "";
    const mirror = direction === "prev" ? ' transform="translate(24,0) scale(-1,1)"' : "";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><g${mirror}>${farTriangle}${nearTriangle}${bar}</g></svg>`;
}

/* Same currentColor-SVG-not-emoji reasoning as every icon in this file - the standard
   four-corner-bracket "expand"/"contract" glyph pair. Used by chrome-transport.js's
   web-only fullscreen toggle (Xbox/Android have no equivalent - the Xbox shell already
   runs fullscreen with no chrome to hide, and Android's chrome is native, not this file)
   and reused by chrome-menu-effects.js's Shader Upscaling row for its own icon, hence
   `isFullscreen` staying a parameter rather than a fixed glyph. */
export function fullscreenIconMarkup(isFullscreen) {
    const path = isFullscreen ?
        "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" :
        "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`;
}

/* Same currentColor-SVG reasoning as fullscreenIconMarkup above - a classic closed-
   captions glyph (rounded outline rect + two text-line bars). Used both by the More
   menu's Audio & Subtitles row (see chrome-menu.js's renderMainList) and, on web only, by
   chrome-transport.js's dedicated transport-bar icon (platformTag() !== "xbox") - both open
   the same openAudioSubtitlesOverlay. Geometry mirrors Android's MenuIconView.Icon.SUBTITLES
   exactly (same 24x24 box) so every platform reads as the same icon. */
export function audioSubtitlesIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><rect x="5" y="9" width="10" height="2" rx="1" fill="currentColor"/><rect x="5" y="13" width="6" height="2" rx="1" fill="currentColor"/></svg>';
}

/* Same currentColor-SVG reasoning as every icon above - a stacked-list glyph for the More
   menu's Episodes/Up Next row (see chrome-menu.js's renderMainList), which used to be a
   standalone text button in the transport bar's left cell before that row was removed -
   see chrome-transport.js's header comment. */
export function episodesIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="5" width="18" height="4" rx="1" fill="currentColor"/>
        <rect x="3" y="11" width="18" height="4" rx="1" fill="currentColor"/>
        <rect x="3" y="17" width="18" height="4" rx="1" fill="currentColor"/>
    </svg>`;
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