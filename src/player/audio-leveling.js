import { AUDIO_LEVELING_STORAGE_KEY } from "./ui/shared.js";
import { hasNativePlayer, platformTag } from "./core/platform.js";
/* Circular with xbox-bridge.js (which would import teardown/ensure helpers back from this file
   if it ever needed to - it doesn't yet) - safe for the same "function-body-only reference"
   reason ambient-pipeline.js's own identical cycle documents: postAudioLeveling is only
   referenced inside updateAudioLevelingPipeline's body below, never at module-evaluation time. */
import { postAudioLeveling } from "./xbox-bridge.js";

function isXbox() {
    return hasNativePlayer() && platformTag() === "xbox";
}

/* "Normalize Audio" toggle (in the hamburger menu's "Options" screen - see
   ui/chrome-menu-options.js) - loudness normalization, not dynamics
   compression: one slowly-adapting gain per title, steering the whole mix toward a
   fixed target level, rather than a fast envelope follower squashing individual loud/
   quiet moments within a title. Plex exposes no client-usable loudness metadata for
   video tracks (that's a music-only feature) and this app has no backend to pre-analyze
   a file server-side (see CLAUDE.md's "no backend, no proxy" invariant), so the only
   option is to measure it live, ourselves, as playback runs.

   Web and Xbox only - Android's native ExoPlayer leg has its own equivalent
   (AudioLevelingProcessor.java), attached directly to ExoPlayer's audio pipeline since
   native playback there is a separate Activity outside this WebView entirely, the same
   wall every other GPU/canvas pipeline in this directory documents. On web this hooks
   AudioContext.createMediaElementSource onto the real <video> element the <video>+hls.js
   fallback path owns (see web-fallback.js); on Xbox there is no DOM <video> to attach to
   at all, so updateAudioLevelingPipeline below just relays the toggle over the bridge to
   AudioLevelingEffect (PrismUwpEffects) instead - UNVERIFIED ON REAL HARDWARE, see that
   C# class's own header comment for the specific things to check when testing this.

   Same lean "toggle IS the persisted setting" triad as stats-overlay.js - no GPU/canvas
   resources, just a Web Audio graph plus a plain setInterval measurement loop. */

/* Target level (RMS, approximate dBFS - not full ITU-R BS.1770 K-weighted LUFS, a
   deliberate simplification) every title's long-run average is steered toward. */
const TARGET_DBFS = -20;
/* Clamp on the *correction* itself, not the output level - keeps a title that opens on
   near-silence (a black screen, a quiet music sting) from momentarily demanding an
   absurd gain before the running average has had time to settle. First-guess numbers;
   expect to retune by ear once this is actually playable. */
const MAX_GAIN_DB = 15;
const MIN_GAIN_DB = -15;
const MEASURE_INTERVAL_MS = 300;
/* Exponential-moving-average smoothing on the loudness estimate itself - large relative
   to MEASURE_INTERVAL_MS on purpose, so the estimate (and therefore the gain it drives)
   settles over tens of seconds, never within one scene. This, plus the gain ramp's own
   time constant below, is what keeps this "leveling" rather than "compression". */
const LOUDNESS_EMA_TAU_S = 20;
const LOUDNESS_EMA_ALPHA = (MEASURE_INTERVAL_MS / 1000) / LOUDNESS_EMA_TAU_S;
/* How slowly gainNode.gain itself is allowed to move toward the newly-computed target -
   an audible jump between measurement ticks would read as pumping, exactly what this
   feature is explicitly not supposed to do. */
const GAIN_RAMP_TIME_CONSTANT_S = 2;
/* Floor for the instantaneous dBFS reading before it ever reaches the EMA - true silence
   (a paused video, a black-screen beat with no score) is -Infinity in dB, which would
   otherwise drag the running average toward "everything needs the max boost" the moment
   playback resumes. */
const SILENCE_FLOOR_DBFS = -60;

export function setAudioLevelingEnabled(controller, enabled) {
    controller._audioLevelingEnabled = enabled;
    localStorage.setItem(AUDIO_LEVELING_STORAGE_KEY, enabled ? "1" : "0");
    updateAudioLevelingPipeline(controller);
}

export function updateAudioLevelingPipeline(controller) {
    /* Xbox has nothing else to do here - no <video> element for a Web Audio graph to hook, and
       (unlike Ambient Lighting) no DOM-side sampling/panel job to keep running independent of the
       toggle either. Relay and return, same "one message, nothing else on this leg" shape as
       postAmbientLighting's own Xbox branch would be if that pipeline had no DOM component. */
    if (isXbox()) {
        postAudioLeveling(!!controller._audioLevelingEnabled);
        return;
    }
    /* No real <video> element on this leg (Android's native playback) - nothing to hook a Web
       Audio graph onto at all. */
    if (!controller._videoEl) return;
    if (!controller._audioLevelingEnabled) {
        stopAudioLevelingLoop(controller);
        /* Ramp back to neutral rather than snapping - same anti-pop reasoning as the
           measurement loop's own gain ramp below. Only meaningful if a pipeline was
           actually built; harmless no-op otherwise. */
        controller._audioLevelingGainNode?.gain.setTargetAtTime(1, controller._audioLevelingCtx.currentTime, GAIN_RAMP_TIME_CONSTANT_S);
        return;
    }
    if (!ensureAudioLevelingPipeline(controller)) {
        controller._audioLevelingEnabled = false;
        return;
    }
    startAudioLevelingLoop(controller);
}

/* Lazy + idempotent, but keyed on controller._videoEl itself (not just "does a context
   already exist") - a title switch tears down and rebuilds the <video> element (see
   plex-player.js's _switchTitle), and createMediaElementSource can only ever be called
   once per element; a second call on the same element throws. Keying the guard on the
   element means a fresh title naturally rebuilds a fresh graph and starts measuring from
   neutral again, which is the intended per-title behavior anyway. */
export function ensureAudioLevelingPipeline(controller) {
    if (controller._audioLevelingVideoEl === controller._videoEl && controller._audioLevelingCtx) return true;
    try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContextCtor();
        const source = ctx.createMediaElementSource(controller._videoEl);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        const gainNode = ctx.createGain();
        source.connect(analyser);
        analyser.connect(gainNode);
        gainNode.connect(ctx.destination);
        controller._audioLevelingCtx = ctx;
        controller._audioLevelingSource = source;
        controller._audioLevelingAnalyser = analyser;
        controller._audioLevelingGainNode = gainNode;
        controller._audioLevelingVideoEl = controller._videoEl;
        controller._audioLevelingEmaDb = null;
        controller._audioLevelingSampleBuffer = new Float32Array(analyser.fftSize);
        /* Browsers require a user gesture before an AudioContext will actually render -
           playback itself only ever starts from one (the Play button/tap), so this should
           already be satisfied, but resume() is cheap insurance against a context that
           landed in "suspended". */
        ctx.resume().catch(() => {});
        return true;
    } catch (e) {
        /* Unsupported AudioContext, or a CORS-tainted element (shouldn't happen given this
           repo's verified Plex CORS-via-query-token invariant, but this leg is new territory
           and shouldn't be able to break playback if that assumption is ever wrong somewhere) -
           disable quietly rather than throwing out of what's meant to be an optional toggle. */
        console.error("StreamingPlayer: audio leveling setup failed -", e);
        return false;
    }
}

export function startAudioLevelingLoop(controller) {
    if (controller._audioLevelingIntervalId) return;
    controller._audioLevelingIntervalId = setInterval(() => measureAndAdjust(controller), MEASURE_INTERVAL_MS);
}

export function stopAudioLevelingLoop(controller) {
    if (controller._audioLevelingIntervalId) {
        clearInterval(controller._audioLevelingIntervalId);
        controller._audioLevelingIntervalId = null;
    }
}

function measureAndAdjust(controller) {
    const analyser = controller._audioLevelingAnalyser;
    const gainNode = controller._audioLevelingGainNode;
    const ctx = controller._audioLevelingCtx;
    if (!analyser || !gainNode || !ctx || controller._videoEl?.paused) return;
    const buffer = controller._audioLevelingSampleBuffer;
    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    const rms = Math.sqrt(sumSquares / buffer.length);
    const instantDb = Math.max(SILENCE_FLOOR_DBFS, rms > 0 ? 20 * Math.log10(rms) : SILENCE_FLOOR_DBFS);

    const prevEma = controller._audioLevelingEmaDb;
    const emaDb = prevEma == null ? instantDb : prevEma + LOUDNESS_EMA_ALPHA * (instantDb - prevEma);
    controller._audioLevelingEmaDb = emaDb;

    const targetDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_DBFS - emaDb));
    const linearGain = Math.pow(10, targetDb / 20);
    gainNode.gain.setTargetAtTime(linearGain, ctx.currentTime, GAIN_RAMP_TIME_CONSTANT_S);
}

/* Called from web-fallback.js's teardownWeb alongside the other pipelines' own teardown -
   safe to call unconditionally even if nothing was ever built. No "restore the element's
   default audio routing" step needed: createMediaElementSource permanently reroutes the
   element's output into the Web Audio graph for as long as the element exists, and the
   element itself is destroyed right after this call anyway (see teardownWeb). */
export function teardownAudioLeveling(controller) {
    stopAudioLevelingLoop(controller);
    if (controller._audioLevelingCtx) {
        controller._audioLevelingCtx.close().catch(() => {});
    }
    controller._audioLevelingCtx = null;
    controller._audioLevelingSource = null;
    controller._audioLevelingAnalyser = null;
    controller._audioLevelingGainNode = null;
    controller._audioLevelingVideoEl = null;
    controller._audioLevelingEmaDb = null;
    controller._audioLevelingSampleBuffer = null;
}
