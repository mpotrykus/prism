import { QUALITY_CAP_PRESETS, AUTO_QUALITY_STORAGE_KEY } from "../ui/shared.js";

/* Plex's transcode endpoint hands back one fixed-bitrate rendition per request (see
   stream-url.js) - there's no multi-variant HLS manifest for hls.js to do real seamless
   ABR against. This walks the same QUALITY_CAP_PRESETS ladder the manual Quality Cap menu
   already offers, triggering the existing reload mechanism (reloadWebSource) to step
   up/down - not seamless, same brief stall a manual switch already causes, so the
   thresholds below are deliberately conservative about how often that's worth paying.

   Only meaningful on the hls.js code path (controller._hls truthy, see web-fallback.js's
   attachSource) - the native-HLS <video> branch has no bandwidthEstimate equivalent, so
   updateAbrMonitor below simply never starts the loop there; chrome.js's
   openQualityCapMenu is what tells the user that explicitly ("unavailable") rather than
   this module pretending it's running. */

export const TICK_INTERVAL_MS = 5000;
export const COOLDOWN_MS = 20000;
export const STABILITY_WINDOW_TICKS = 6;
export const DOWNGRADE_CONFIRM_TICKS = 2;
export const STEP_UP_HEADROOM_MULTIPLIER = 1.5;
export const STEP_DOWN_THRESHOLD_MULTIPLIER = 0.9;

/* Original (kbps: null) has no numeric cap of its own to compare bandwidth against - the
   1080p rung's own number stands in for "how much Original demands" on both sides of the
   threshold math below. */
const ORIGINAL_PROXY_KBPS = 20000;

function rungKbps(preset) {
    return preset.kbps ?? ORIGINAL_PROXY_KBPS;
}

function currentRungIndex(qualityCapKbps) {
    const index = QUALITY_CAP_PRESETS.findIndex((p) => (p.kbps ?? null) === (qualityCapKbps ?? null));
    return index === -1 ? 0 : index;
}

/* Pure decision function, kept separate from the stateful tick loop below so
   abr.test.js can exercise every threshold directly. Index 0 is the ceiling (Original),
   the last index is the floor (360p) - stepping "up" in quality means a LOWER index. */
export function decideAbrAction({ currentIndex, bandwidthKbps, downgradeStreak, stableStreak }) {
    const atFloor = currentIndex >= QUALITY_CAP_PRESETS.length - 1;
    const atCeiling = currentIndex <= 0;
    const currentKbps = rungKbps(QUALITY_CAP_PRESETS[currentIndex]);

    if (bandwidthKbps < currentKbps * STEP_DOWN_THRESHOLD_MULTIPLIER) {
        const nextDowngradeStreak = downgradeStreak + 1;
        if (!atFloor && nextDowngradeStreak >= DOWNGRADE_CONFIRM_TICKS) {
            return { action: "down", nextIndex: currentIndex + 1, downgradeStreak: 0, stableStreak: 0 };
        }
        return { action: "none", nextIndex: currentIndex, downgradeStreak: nextDowngradeStreak, stableStreak: 0 };
    }

    if (atCeiling) {
        return { action: "none", nextIndex: currentIndex, downgradeStreak: 0, stableStreak: 0 };
    }

    const nextUpKbps = rungKbps(QUALITY_CAP_PRESETS[currentIndex - 1]);
    if (bandwidthKbps >= nextUpKbps * STEP_UP_HEADROOM_MULTIPLIER) {
        const nextStableStreak = stableStreak + 1;
        if (nextStableStreak >= STABILITY_WINDOW_TICKS) {
            return { action: "up", nextIndex: currentIndex - 1, downgradeStreak: 0, stableStreak: 0 };
        }
        return { action: "none", nextIndex: currentIndex, downgradeStreak: 0, stableStreak: nextStableStreak };
    }

    return { action: "none", nextIndex: currentIndex, downgradeStreak: 0, stableStreak: 0 };
}

function withinCooldown(controller) {
    return Date.now() - controller._abrLastSwitchAt < COOLDOWN_MS;
}

function switchToRung(controller, index) {
    controller._abrLastSwitchAt = Date.now();
    controller._abrDowngradeStreak = 0;
    controller._abrStableStreak = 0;
    controller._reloadWebSource({ qualityCapKbps: QUALITY_CAP_PRESETS[index].kbps });
}

function evaluateAbrTick(controller) {
    if (!controller._session || !controller._hls || withinCooldown(controller)) return;
    /* hls.js's bandwidthEstimate starts at a synthetic default (~500kbps) before any real
       fragment has loaded - attachSource resets _abrHasRealSample to false on every fresh
       Hls instance and flips it true on the first FRAG_LOADED, so this tick simply skips
       until there's a real number to act on rather than misreading the fake default as a
       terrible connection. */
    if (!controller._abrHasRealSample) return;
    const bandwidthKbps = controller._hls.bandwidthEstimate / 1000;
    const currentIndex = currentRungIndex(controller._session.qualityCapKbps);
    const result = decideAbrAction({
        currentIndex,
        bandwidthKbps,
        downgradeStreak: controller._abrDowngradeStreak,
        stableStreak: controller._abrStableStreak,
    });
    controller._abrDowngradeStreak = result.downgradeStreak;
    controller._abrStableStreak = result.stableStreak;
    if (result.action !== "none") switchToRung(controller, result.nextIndex);
}

/* Bypasses the stability window entirely (unlike the tick-based step-down above, which
   waits for DOWNGRADE_CONFIRM_TICKS of sustained shortfall) - a real stall is bad enough
   to act on immediately, still gated by the same cooldown as every other switch so a
   stall firing just after our own reload isn't mistaken for a fresh one. */
export function notifyStall(controller) {
    if (!controller._autoQualityEnabled || !controller._session || withinCooldown(controller)) return;
    const currentIndex = currentRungIndex(controller._session.qualityCapKbps);
    if (currentIndex >= QUALITY_CAP_PRESETS.length - 1) return;
    switchToRung(controller, currentIndex + 1);
}

/* Called from every reload path (manual preset pick, version/audio switch, title switch,
   or an auto-triggered switch itself) - a fresh transcode session means whatever
   streak/cooldown state was building against the old one no longer applies. */
export function notifyReload(controller) {
    controller._abrLastSwitchAt = Date.now();
    controller._abrDowngradeStreak = 0;
    controller._abrStableStreak = 0;
}

export function startAbrLoop(controller) {
    if (controller._abrIntervalId) return;
    controller._abrIntervalId = setInterval(() => evaluateAbrTick(controller), TICK_INTERVAL_MS);
}

export function stopAbrLoop(controller) {
    if (controller._abrIntervalId) {
        clearInterval(controller._abrIntervalId);
        controller._abrIntervalId = null;
    }
}

export function updateAbrMonitor(controller) {
    if (controller._autoQualityEnabled && controller._hls) {
        startAbrLoop(controller);
    } else {
        stopAbrLoop(controller);
    }
}

export function setAutoQualityEnabled(controller, enabled) {
    controller._autoQualityEnabled = enabled;
    localStorage.setItem(AUTO_QUALITY_STORAGE_KEY, enabled ? "1" : "0");
    updateAbrMonitor(controller);
}
