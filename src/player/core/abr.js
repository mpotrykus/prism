import { QUALITY_CAP_PRESETS, AUTO_QUALITY_STORAGE_KEY } from "../ui/shared.js";

/* Plex's transcode endpoint hands back one fixed-bitrate rendition per request (see
   stream-url.js) - there's no multi-variant HLS manifest for hls.js to do real seamless
   ABR against. This walks the same QUALITY_CAP_PRESETS ladder the manual Quality Cap menu
   already offers, triggering the existing reload mechanism (reloadWebSource) to step
   up/down - not seamless, same brief stall a manual switch already causes, so the
   thresholds below are deliberately conservative about how often that's worth paying.

   Only meaningful when a bandwidth source has been registered (see setBandwidthSource) -
   Safari's native-HLS <video> branch has no bandwidthEstimate equivalent, so
   updateAbrMonitor below simply never starts the loop there; chrome.js's
   openQualityCapMenu is what tells the user that explicitly ("unavailable") rather than
   this module pretending it's running.

   The gate used to be `controller._hls` directly, which made Auto Quality silently
   unavailable on any backend that isn't hls.js (a native player has no Hls instance) with
   no signal beyond that "unavailable" label. It's a registered source object now so
   decideAbrAction below stays the one decision implementation for every backend rather
   than each growing its own copy. */

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

/* On a confirmed shortfall, jump straight to the best rung the current bandwidth actually
   supports instead of dropping one rung at a time and re-running the confirm streak against
   each intermediate rung in turn - a connection that craters from Original to 360p-worthy
   used to take several DOWNGRADE_CONFIRM_TICKS-gated switches to get there. Falls through to
   the floor if bandwidth doesn't clear even that. */
function bestDowngradeTarget(currentIndex, bandwidthKbps) {
    for (let i = currentIndex + 1; i < QUALITY_CAP_PRESETS.length - 1; i++) {
        if (bandwidthKbps >= rungKbps(QUALITY_CAP_PRESETS[i]) * STEP_DOWN_THRESHOLD_MULTIPLIER) {
            return i;
        }
    }
    return QUALITY_CAP_PRESETS.length - 1;
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
            const nextIndex = bestDowngradeTarget(currentIndex, bandwidthKbps);
            return { action: "down", nextIndex, downgradeStreak: 0, stableStreak: 0 };
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

/* Registers whatever object can answer "what's the current bandwidth estimate, in bits per
   second" for the active playback backend. On web that's the hls.js instance itself (its
   own `bandwidthEstimate` property is already exactly this shape); a native player passes a
   small object it updates from the samples its own downloader reports. Pass null for a
   backend that can't measure bandwidth at all (Safari's native-HLS <video> branch), which
   is what keeps Auto Quality correctly reported as unavailable there.

   Also resets _abrHasRealSample, since a new source has measured nothing yet - callers
   don't have to remember to do that separately. */
export function setBandwidthSource(controller, source) {
    controller._bandwidthSource = source || null;
    controller._abrHasRealSample = false;
}

export function bandwidthSource(controller) {
    return controller._bandwidthSource || null;
}

/* Stall-driven mode, for a backend that can measure playback health but not bandwidth.

   Xbox's native player is the case: it plays Plex's progressive output through
   MediaSource.CreateFromUri, which hands all HTTP fetching to MediaFoundation, so there are no
   per-segment byte/duration callbacks to derive kbps from (and Plex's progressive transcode does not
   reliably send Content-Length, so DownloadProgress is not a substitute). What it does get is real
   rebuffer events.

   So the ladder is driven by outcome instead of prediction: notifyStall() below already handles
   stepping down on a genuine rebuffer, and this mode adds the matching step-up after
   STABILITY_WINDOW_TICKS of uninterrupted playback. Deliberately NOT implemented by synthesising a
   fake bandwidthEstimate to feed decideAbrAction - a made-up number driving threshold maths reads
   as a real measurement to every future reader, and would be impossible to reason about.

   Trade-off worth knowing: step-up here is time-based rather than headroom-based, so recovery after
   a transient dip is slower than the web path's, and it cannot tell "the connection improved" from
   "nothing has gone wrong yet". Downgrades are unaffected - those are driven by real stalls. */
export function setStallDrivenAbr(controller, enabled) {
    controller._abrStallDriven = !!enabled;
}

function switchToRung(controller, index) {
    controller._abrLastSwitchAt = Date.now();
    controller._abrDowngradeStreak = 0;
    controller._abrStableStreak = 0;
    controller._reloadSource({ qualityCapKbps: QUALITY_CAP_PRESETS[index].kbps });
}

/* The stall-driven counterpart to decideAbrAction, and pure for the same reason: so abr.test.js can
   exercise the threshold directly rather than through the interval. No bandwidth to compare against,
   so a tick that happens with playback running and no stall since the last switch is itself the
   evidence that the current rung is sustainable. Same STABILITY_WINDOW_TICKS as the bandwidth path,
   so the two behave comparably from the user's point of view.

   Stepping DOWN is not handled here - that comes from notifyStall, driven by a real rebuffer. */
export function decideStallDrivenAction({ currentIndex, stableStreak }) {
    if (currentIndex <= 0) {
        return { action: "none", nextIndex: currentIndex, stableStreak: 0 };
    }
    const nextStableStreak = stableStreak + 1;
    if (nextStableStreak >= STABILITY_WINDOW_TICKS) {
        return { action: "up", nextIndex: currentIndex - 1, stableStreak: 0 };
    }
    return { action: "none", nextIndex: currentIndex, stableStreak: nextStableStreak };
}

function evaluateStallDrivenTick(controller) {
    if (!controller._session || withinCooldown(controller)) return;
    const result = decideStallDrivenAction({
        currentIndex: currentRungIndex(controller._session.qualityCapKbps),
        stableStreak: controller._abrStableStreak,
    });
    controller._abrStableStreak = result.stableStreak;
    if (result.action !== "none") switchToRung(controller, result.nextIndex);
}

function evaluateAbrTick(controller) {
    if (controller._abrStallDriven) {
        evaluateStallDrivenTick(controller);
        return;
    }
    const source = bandwidthSource(controller);
    if (!controller._session || !source || withinCooldown(controller)) return;
    /* hls.js's bandwidthEstimate starts at a synthetic default (~500kbps) before any real
       fragment has loaded - setBandwidthSource resets _abrHasRealSample on every fresh
       source and the backend flips it true once a real segment finishes (hls.js's
       FRAG_LOADED on web), so this tick simply skips until there's a real number to act on
       rather than misreading the fake default as a terrible connection. */
    if (!controller._abrHasRealSample) return;
    const bandwidthKbps = source.bandwidthEstimate / 1000;
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
    /* Cleared before the cooldown check, not after: in stall-driven mode the stable streak IS the
       step-up trigger, so a stall that arrives during cooldown must still cancel progress toward
       stepping up. Otherwise a connection stalling once per cooldown window would keep climbing. */
    controller._abrStableStreak = 0;
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
    if (controller._autoQualityEnabled && (bandwidthSource(controller) || controller._abrStallDriven)) {
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
