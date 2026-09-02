import PLAYER_SETTINGS_DEFAULTS from "../player-settings.defaults.json";

export const CONTROLS_HIDE_DELAY_MS = 1000;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
/* key matches both the CSS object-fit keyword this maps to on the web leg (see
   chrome-menu-options.js's applyFitMode) and the Xbox bridge's "mode" param
   (NativePlayerHost.SetStretch) - "stretch" is the one exception, mapped to
   object-fit:fill/Stretch.Fill rather than reusing the word "fill" itself, since
   "Stretch" is the clearer label to show the viewer. */
export const FIT_MODES = [
    { key: "fit", label: "Fit" },
    { key: "cover", label: "Cover" },
    { key: "stretch", label: "Stretch" },
];
/* kbps: null means "no cap" (Original) - matched against the selected quality cap by
   identity in chrome-menu.js's openQualityCapMenu, so keep it null rather than 0 or a
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
export const COLOR_BOOST_SATURATION_ENABLED_STORAGE_KEY = "prism_player_color_boost_saturation_enabled";
export const COLOR_BOOST_CONTRAST_ENABLED_STORAGE_KEY = "prism_player_color_boost_contrast_enabled";
export const COLOR_BOOST_SATURATION_STRENGTH_STORAGE_KEY = "prism_player_color_boost_saturation_strength";
export const COLOR_BOOST_CONTRAST_STRENGTH_STORAGE_KEY = "prism_player_color_boost_contrast_strength";
export const COLOR_BOOST_SATURATION_AUTO_STORAGE_KEY = "prism_player_color_boost_saturation_auto";
export const COLOR_BOOST_CONTRAST_AUTO_STORAGE_KEY = "prism_player_color_boost_contrast_auto";
export const AI_UPSCALING_STORAGE_KEY = "prism_player_ai_upscaling_enabled";
export const STATS_OVERLAY_STORAGE_KEY = "prism_player_stats_overlay_enabled";
export const AUTO_PLAY_STORAGE_KEY = "prism_player_auto_play_enabled";
export const AUTO_QUALITY_STORAGE_KEY = "prism_player_auto_quality_enabled";
export const AUTO_SKIP_INTRO_CREDITS_STORAGE_KEY = "prism_player_auto_skip_intro_credits_enabled";
export const AUDIO_LEVELING_STORAGE_KEY = "prism_player_audio_leveling_enabled";
export const AUTO_CROP_STORAGE_KEY = "prism_player_auto_crop_enabled";

function storedBool(key, defaultValue) {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultValue : stored === "1";
}

function storedFloat01(key, defaultValue) {
    const stored = localStorage.getItem(key);
    const raw = Number(stored);
    return stored !== null && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : defaultValue;
}

export function storedVolume() {
    const raw = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : PLAYER_SETTINGS_DEFAULTS.volume;
}

/* The in-player toggle IS the setting, written here the moment it's flipped (see
   setAmbientEnabled) and read back for every subsequent video, same immediate-
   persistence model as VOLUME_STORAGE_KEY above - no Settings-modal default to reconcile
   against. */
export function storedAmbientEnabled() {
    return storedBool(AMBIENT_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.ambientEnabled);
}

/* Same immediate-persistence model as storedAmbientEnabled above - opacity has no
   per-video/genre concern to reconcile either. The explicit `stored !== null` check
   matters: Number(null) is 0, not NaN, which would otherwise pass the >= 0 check below
   and silently make "never set" indistinguishable from "explicitly set to 0" - every
   fresh session would start at 0% (invisible) instead of the intended 50% default. */
export function storedAmbientOpacity() {
    return storedFloat01(AMBIENT_OPACITY_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.ambientOpacity);
}

/* Same immediate-persistence model as storedAmbientEnabled - whatever the in-player
   Shader Upscaling toggle was last set to (see shader-pipeline.js's setShaderEnabled),
   not a Settings-modal default reset every video. detectShaderType's own per-video genre
   detection is unrelated to this and still resolves fresh every time (see
   player.js's play()). */
export function storedShaderEnabled() {
    return storedBool(UPSCALE_ENABLED_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.shaderEnabled);
}

/* 0.65 is the first-session default (it was "Medium" back when this was a preset dropdown).

   The explicit `stored !== null` check matters: Number(null) is 0, not NaN, so a never-set key
   would silently default to strength 0 rather than 0.65 - which made Auto mode look permanently
   stuck at 0% for anyone who had never touched the manual slider. */
export function storedShaderStrength() {
    return storedFloat01(UPSCALE_STRENGTH_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.shaderStrength);
}

/* Same immediate-persistence model as storedShaderEnabled above. The resolved auto
   strength itself is never persisted, only this flag - see shader-pipeline.js's
   renderShaderFrame. */
export function storedUpscaleAuto() {
    return storedBool(UPSCALE_AUTO_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.upscaleAuto);
}

/* Saturation and Contrast are fully independent controls, so each gets its own key. */
export function storedColorBoostSaturationEnabled() {
    return storedBool(COLOR_BOOST_SATURATION_ENABLED_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostSaturationEnabled);
}

export function storedColorBoostContrastEnabled() {
    return storedBool(COLOR_BOOST_CONTRAST_ENABLED_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostContrastEnabled);
}

/* Same `stored !== null` reasoning as storedShaderStrength above; one key per slider. */
export function storedColorBoostSaturationStrength() {
    return storedFloat01(COLOR_BOOST_SATURATION_STRENGTH_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostSaturationStrength);
}

export function storedColorBoostContrastStrength() {
    return storedFloat01(COLOR_BOOST_CONTRAST_STRENGTH_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostContrastStrength);
}

/* Same immediate-persistence model as storedColorBoostSaturationEnabled/storedUpscaleAuto
   above - the resolved auto strength itself is never persisted, only this flag - see
   shader-pipeline.js's renderShaderFrame. Independent per component: each auto-derives
   from its own signal (avgSaturation vs lumaStdDev), so there's no shared auto state left
   to key one flag off. */
export function storedColorBoostSaturationAuto() {
    return storedBool(COLOR_BOOST_SATURATION_AUTO_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostSaturationAuto);
}

export function storedColorBoostContrastAuto() {
    return storedBool(COLOR_BOOST_CONTRAST_AUTO_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.colorBoostContrastAuto);
}

/* Defaults off like every other quality-toggle here (Ambient/Color Boost/Sharpening's own
   default-off siblings) - AI Upscaling is opt-in for a never-touched user. */
export function storedAiUpscalingEnabled() {
    return storedBool(AI_UPSCALING_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.aiUpscalingEnabled);
}

/* Same immediate-persistence model as storedAmbientEnabled - a debug readout has no
   per-video/genre concern to reconcile either. */
export function storedStatsOverlayEnabled() {
    return storedBool(STATS_OVERLAY_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.statsOverlayEnabled);
}

/* Same immediate-persistence model as storedStatsOverlayEnabled - no per-video/genre
   concern, whatever this was last toggled to is what every subsequent session starts
   from. Defaults to on (unlike the quality/effect toggles, and unlike
   storedAutoSkipIntroCreditsEnabled/storedAudioLevelingEnabled which default off) for a user
   who's never touched this setting at all - a bare-missing key, not an explicit "0". */
export function storedAutoPlayEnabled() {
    return storedBool(AUTO_PLAY_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.autoPlayEnabled);
}

/* Unlike storedAutoPlayEnabled, this does NOT default on for a never-touched user -
   every Auto Quality step (up or down) is a real server-side transcode restart (see
   core/abr.js), not a free/seamless adjustment, so a user who's never opted in
   shouldn't have Plex silently re-transcoding their stream. */
export function storedAutoQualityEnabled() {
    return storedBool(AUTO_QUALITY_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.autoQualityEnabled);
}

/* Unlike storedAutoPlayEnabled, this defaults OFF for a never-touched user - auto-skipping
   past content (rather than just auto-advancing between titles) is intrusive enough that a
   user should opt in rather than have it sprung on them. */
export function storedAutoSkipIntroCreditsEnabled() {
    return storedBool(AUTO_SKIP_INTRO_CREDITS_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.autoSkipIntroCreditsEnabled);
}

/* Defaults OFF for a never-touched user - same reasoning as storedAutoQualityEnabled above:
   normalizing volume changes the audio itself (compression/gain), which shouldn't be sprung
   on a fresh install without the user opting in. Once they do touch it, their choice
   (on or off) persists across sessions like every other stored toggle. */
export function storedAudioLevelingEnabled() {
    return storedBool(AUDIO_LEVELING_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.audioLevelingEnabled);
}

/* Same `stored === null` default-on reasoning as storedAutoPlayEnabled above - unlike the
   quality/effect toggles, a never-touched user should get baked-in black bars cropped
   automatically rather than opt in, since a title with a matted-in border is otherwise
   wrapped in two stacked sets of bars (see auto-crop.js's own header comment). */
export function storedAutoCropEnabled() {
    return storedBool(AUTO_CROP_STORAGE_KEY, PLAYER_SETTINGS_DEFAULTS.autoCropEnabled);
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
    return `<svg viewBox="-6 -9 36 36" width="36" height="36" fill="none" xmlns="http://www.w3.org/2000/svg">${arc}${arrow}${label}</svg>`;
}

/* Same currentColor-SVG reasoning as audioSubtitlesIconMarkup below - drawn from scratch
   rather than an "⏮"/"⏭" glyph, which has the same fixed-color emoji-presentation problem.
   Shared by chrome-menu.js's Auto-Play row (single triangle) and chrome-transport.js's
   mouse/hover-chrome chapter/title-nav transport buttons (double triangle, see
   !usesGamepadChrome() gating in buildCenterControls) - the `double` option tells the two
   uses apart. */
export function skipIconMarkup(direction, { double = false } = {}) {
    const bar = '<rect x="16.6" y="5" width="2.2" height="14" rx="0.6" fill="currentColor"/>';
    const nearTriangle = '<polygon points="8,5 8,19 16.2,12" fill="currentColor"/>';
    const farTriangle = double ? '<polygon points="0.4,5 0.4,19 8.6,12" fill="currentColor"/>' : "";
    const mirror = direction === "prev" ? ' transform="translate(24,0) scale(-1,1)"' : "";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><g${mirror}>${farTriangle}${nearTriangle}${bar}</g></svg>`;
}

/* Same currentColor-SVG-not-emoji reasoning as every icon in this file - the standard
   four-corner-bracket "expand"/"contract" glyph pair. Used by chrome-transport.js's
   fullscreen toggle, rendered wherever there's real window chrome to hide - web and PC
   (real Xbox already runs fullscreen with none to hide, and Android's chrome is native,
   not this file) - and reused by chrome-menu-effects.js's Shader Upscaling row for its own
   icon, hence `isFullscreen` staying a parameter rather than a fixed glyph. */
export function fullscreenIconMarkup(isFullscreen) {
    const path = isFullscreen ?
        "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" :
        "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z";
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`;
}

/* Same currentColor-SVG reasoning as fullscreenIconMarkup above - a classic closed-
   captions glyph (rounded outline rect + two text-line bars), for chrome-transport.js's
   dedicated transport-bar icon (mouse/hover chrome only, !usesGamepadChrome()) that opens
   openAudioSubtitlesOverlay directly. Geometry mirrors Android's MenuIconView.Icon.SUBTITLES
   exactly (same 24x24 box) so every platform reads as the same icon. */
export function audioSubtitlesIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><rect x="5" y="9" width="10" height="2" rx="1" fill="currentColor"/><rect x="5" y="13" width="6" height="2" rx="1" fill="currentColor"/></svg>';
}

/* Same currentColor-SVG reasoning as every icon above - three list lines plus a trailing
   play triangle, for chrome-menu.js's Xbox-only "Episodes"/"Up Next" More-menu row (Xbox
   has no transport-bar icon to put this on instead - see that file's own comment on why
   the row exists there at all). Geometry mirrors Android's MenuIconView.Icon.EPISODES
   exactly so every platform reads as the same icon. */
export function episodesIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="4" width="12" height="2" rx="1" fill="currentColor"/>
        <rect x="1" y="10" width="12" height="2" rx="1" fill="currentColor"/>
        <rect x="1" y="16" width="12" height="2" rx="1" fill="currentColor"/>
        <path d="M17 8 L17 16 L23 12 Z" fill="currentColor"/>
    </svg>`;
}

/* Icons for each row of the More menu (chrome-menu.js's buildAccordionRow/renderPickerRows
   callers) - one markup function per row, same currentColor-SVG-not-emoji reasoning as
   every icon above. A handful of rows deliberately reuse an existing markup above
   rather than getting their own (Auto-Play reuses skipIconMarkup's "next" glyph, Shader
   Upscaling reuses fullscreenIconMarkup's expand glyph) since those already draw the
   right concept - see openHamburgerMenu/renderEffectsList/renderOptionsList in src/player/ui/
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

/* A plain 6-tooth gear - the standard "settings/options" glyph, for chrome-menu.js's "Options"
   row (Normalize Audio/Auto-Play/Auto-Skip Intro & Credits - see chrome-menu-options.js).
   Teeth are hand-placed at 60-degree increments around a radius-8.5 ring rather than computed
   at load time, matching every other icon in this file's plain-literal-coordinates style.
   Geometry mirrors Android's MenuIconView.Icon.OPTIONS exactly. */
export function optionsIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
        <rect x="19" y="10.5" width="3" height="3" rx="0.6" fill="currentColor"/>
        <rect x="14.75" y="17.86" width="3" height="3" rx="0.6" fill="currentColor"/>
        <rect x="6.25" y="17.86" width="3" height="3" rx="0.6" fill="currentColor"/>
        <rect x="2" y="10.5" width="3" height="3" rx="0.6" fill="currentColor"/>
        <rect x="6.25" y="3.14" width="3" height="3" rx="0.6" fill="currentColor"/>
        <rect x="14.75" y="3.14" width="3" height="3" rx="0.6" fill="currentColor"/>
    </svg>`;
}

export function effectsIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.2 6.2L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.8L12 2z"/></svg>';
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

/* AI Upscaling's glyph: a four-point sparkle, the common shorthand for "AI-enhanced" - distinct
   from Sharpening's expand-corners glyph (fullscreenIconMarkup) since the two are now
   independent toggles, not one feature that silently swaps which algorithm is behind it. */
export function aiUpscalingIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/>
        <path d="M19 15l0.9 2.1 2.1 0.9-2.1 0.9-0.9 2.1-0.9-2.1-2.1-0.9 2.1-0.9z"/>
    </svg>`;
}

export function speedIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 18a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="12" y1="18" x2="16" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="12" cy="18" r="1.4" fill="currentColor"/>
    </svg>`;
}

export function aspectIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <rect x="7" y="9" width="10" height="6" rx="1" stroke="currentColor" stroke-width="1.4"/>
    </svg>`;
}

/* Same currentColor-SVG reasoning as every icon above - a speaker glyph with two evened-out
   bars instead of volumeIconMarkup's growing sound waves, to read as "leveling" rather than
   "loud"/"quiet" at a glance. */
export function audioLevelingIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
        <rect x="15" y="8" width="7" height="2.4" rx="1.2" fill="currentColor"/>
        <rect x="15" y="13.6" width="7" height="2.4" rx="1.2" fill="currentColor"/>
    </svg>`;
}

export function sleepIconMarkup() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
}

/* Standard two-L-bracket crop-tool glyph, not a magnifier/zoom icon - "Auto-Crop" removes
   baked-in black bars (a crop), it doesn't magnify the picture, even though the on-screen
   effect is a zoom (see auto-crop.js's own header comment for why cropping a border
   necessarily renders as one). */
export function autoCropIconMarkup() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 2v14a2 2 0 0 0 2 2h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M18 22V8a2 2 0 0 0-2-2H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}
