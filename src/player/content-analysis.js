import { autoUpscaleStrength, autoColorBoostStrength, autoContrastBoostStrength } from "./shader/shaders.js";
import { hasNativePlayer, platformTag } from "./core/platform.js";
import { media } from "./core/media-facade.js";
/* Circular with shader-pipeline.js (which imports updateContentAnalysis from this file, while
   this file imports postXboxShaderSettings/postXboxColorBoostSettings from it) - safe for the
   same "only referenced inside function bodies, never at module-evaluation time" reason as the
   other cycles in this directory. */
import { postXboxShaderSettings, postXboxColorBoostSettings } from "./shader-pipeline.js";

/* Content-analysis pipeline backing "Auto strength" for Shader Upscaling and Color
   Boost (web/Xbox - Android's native ExoPlayer leg has its own equivalent built from
   ContentAnalysisSampler, same "native playback renders outside this WebView entirely"
   wall documented in ambient-pipeline.js/shader-pipeline.js). Deliberately independent of
   ambient-pipeline.js's own sampling loop even though the two are mechanically similar
   (tiny offscreen canvas, drawImage+getImageData) - Auto strength can be on while Ambient
   Lighting is off, so this can't just piggyback on that loop's lifecycle.

   Throttled far coarser than ambient's 42ms (see AMBIENT_SAMPLE_INTERVAL_MS) - unlike
   ambient light, which should track the picture closely, a strength value visibly
   "pumping" every couple frames would read as a bug, not a feature. Whole-frame stats
   (not ambient's per-edge-zone split) since strength has nothing to do with position. */

const CONTENT_SAMPLE_INTERVAL_MS = 750;
const CONTENT_SAMPLE_W = 32;
const CONTENT_SAMPLE_H = 18;
/* Slower than ambient's own AMBIENT_SMOOTHING_FACTOR (0.3) - at a 750ms tick interval a
   0.3 EMA already settles in ~2s, which is plenty responsive for a strength value that
   shouldn't visibly react to single-frame outliers (a stray bright flash, a single grainy
   shot) the way ambient's per-frame color glow is expected to. */
const CONTENT_SMOOTHING_FACTOR = 0.3;

export function updateContentAnalysis(controller) {
    /* Xbox: no canvas to sample a <video> into - ShaderVideoEffect's ContentAnalysisSampler reads
       real decoded frames instead and reports avgSaturation/edgeEnergy/lumaStdDev back over the
       bridge (see applyXboxContentAnalysis below). setUpscaleAuto/setColorBoostSaturationAuto/
       setColorBoostContrastAuto (shader-pipeline.js) all call this function on every change, and
       native's own "auto" flags live in the same setShaderEffect/setColorBoost message
       shader-pipeline.js already owns building - re-posting here keeps them in sync without a
       third copy of the payload-building logic. */
    if (hasNativePlayer() && platformTag() === "xbox") {
        postXboxShaderSettings(controller);
        postXboxColorBoostSettings(controller);
        return;
    }
    if (!controller._upscaleAuto && !controller._colorBoostSaturationAuto && !controller._colorBoostContrastAuto) {
        stopContentAnalysisLoop(controller);
        return;
    }
    if (!ensureContentAnalysis(controller)) return;
    startContentAnalysisLoop(controller);
}

/* Fed by ShaderVideoEffect's native sampler via xbox-bridge.js's "contentAnalysis" event -
   avgSaturation/edgeEnergy/lumaStdDev are the three numbers a browser canvas can compute itself
   on web, but only native pixel access can produce on Xbox (see ShaderVideoEffect.ProcessFrame).
   Runs through the exact same smoothing + autoUpscaleStrength/autoColorBoostStrength/
   autoContrastBoostStrength math sampleContentFrame below already uses, so there is one tuning
   implementation shared by both platforms - see this module's own header for why that math stays
   in JS rather than being duplicated natively. */
export function applyXboxContentAnalysis(controller, avgSaturation, edgeEnergy, lumaStdDev) {
    applySample(controller, avgSaturation, edgeEnergy, lumaStdDev);
    /* applySample only updates controller._autoUpscaleStrength/_autoColorBoostSaturationStrength/
       _autoColorBoostContrastStrength in memory - native has no way to see those without this.
       Re-posts through the exact same helpers shader-pipeline.js's updateShaderPipeline already
       uses, so native's ShaderVideoEffect picks up the freshly-resolved auto strength on (roughly)
       the same ~750ms cadence this event itself arrives on, rather than only ever seeing whatever
       strength was in effect at the moment Auto mode was first switched on. */
    if (controller._upscaleAuto) postXboxShaderSettings(controller);
    if (controller._colorBoostSaturationAuto || controller._colorBoostContrastAuto) postXboxColorBoostSettings(controller);
}

function ensureContentAnalysis(controller) {
    if (controller._contentSampleCtx) return true;
    const video = controller._videoEl;
    if (!video) return false;
    const canvas = document.createElement("canvas");
    canvas.width = CONTENT_SAMPLE_W;
    canvas.height = CONTENT_SAMPLE_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
        console.error("StreamingPlayer: 2D canvas unavailable, auto strength disabled");
        return false;
    }
    controller._contentSampleCanvas = canvas;
    controller._contentSampleCtx = ctx;
    controller._contentLastSampleAt = 0;
    controller._contentSmoothedSaturation = null;
    controller._contentSmoothedEdgeEnergy = null;
    controller._contentSmoothedLumaStdDev = null;
    return true;
}

function startContentAnalysisLoop(controller) {
    if (controller._contentRafId) return;
    const step = (ts) => {
        sampleContentFrame(controller, ts);
        controller._contentRafId = requestAnimationFrame(step);
    };
    controller._contentRafId = requestAnimationFrame(step);
}

function stopContentAnalysisLoop(controller) {
    if (controller._contentRafId) {
        cancelAnimationFrame(controller._contentRafId);
        controller._contentRafId = null;
    }
}

/* Mirrors shader-pipeline.js's teardownShaderPipeline and ambient-pipeline.js's
   teardownAmbient - each pipeline releases what it allocated, rather than teardownWeb
   having to remember every `_content*` field this module happens to hang off the
   controller. */
export function teardownContentAnalysis(controller) {
    stopContentAnalysisLoop(controller);
    controller._contentSampleCanvas = null;
    controller._contentSampleCtx = null;
    controller._contentSmoothedSaturation = null;
    controller._contentSmoothedEdgeEnergy = null;
    controller._contentSmoothedLumaStdDev = null;
}

function sampleContentFrame(controller, timestamp) {
    const video = controller._videoEl;
    const ctx = controller._contentSampleCtx;
    if (!video || !ctx || video.readyState < video.HAVE_CURRENT_DATA) return;
    if (timestamp - controller._contentLastSampleAt < CONTENT_SAMPLE_INTERVAL_MS) return;
    controller._contentLastSampleAt = timestamp;

    let data;
    try {
        ctx.drawImage(video, 0, 0, CONTENT_SAMPLE_W, CONTENT_SAMPLE_H);
        data = ctx.getImageData(0, 0, CONTENT_SAMPLE_W, CONTENT_SAMPLE_H).data;
    } catch (e) {
        /* Tainted-canvas SecurityError, same CORS invariant ambient-pipeline.js/
           shader-pipeline.js rely on - fail by turning every auto mode back off instead
           of throwing on every animation frame. */
        console.error("StreamingPlayer: auto strength disabled - video frame is cross-origin tainted", e);
        controller._upscaleAuto = false;
        controller._colorBoostSaturationAuto = false;
        controller._colorBoostContrastAuto = false;
        stopContentAnalysisLoop(controller);
        return;
    }

    const rawSaturation = averageSaturation(data);
    const rawEdgeEnergy = averageEdgeEnergy(data, CONTENT_SAMPLE_W, CONTENT_SAMPLE_H);
    const rawLumaStdDev = averageLumaStdDev(data);
    applySample(controller, rawSaturation, rawEdgeEnergy, rawLumaStdDev);
}

/* Shared tail of sampleContentFrame (web) and applyXboxContentAnalysis (Xbox) - everything past
   "raw avgSaturation/edgeEnergy/lumaStdDev numbers exist", which is the only part that differs by
   platform (a canvas sample here, a bridge event there). Saturation and Contrast are
   independently auto-able now (see shader-pipeline.js's setColorBoostSaturationMode/
   setColorBoostContrastMode) - each is gated (and smoothed) on its own auto flag rather than
   sharing one, though the smoothed inputs themselves are cheap enough to just always update. */
function applySample(controller, rawSaturation, rawEdgeEnergy, rawLumaStdDev) {
    controller._contentSmoothedSaturation = smooth(controller._contentSmoothedSaturation, rawSaturation);
    controller._contentSmoothedEdgeEnergy = smooth(controller._contentSmoothedEdgeEnergy, rawEdgeEnergy);
    controller._contentSmoothedLumaStdDev = smooth(controller._contentSmoothedLumaStdDev, rawLumaStdDev);

    if (controller._colorBoostSaturationAuto) {
        controller._autoColorBoostSaturationStrength = autoColorBoostStrength({ avgSaturation: controller._contentSmoothedSaturation });
    }
    if (controller._colorBoostContrastAuto) {
        controller._autoColorBoostContrastStrength = autoContrastBoostStrength({ lumaStdDev: controller._contentSmoothedLumaStdDev });
    }
    if (controller._upscaleAuto) {
        controller._autoUpscaleStrength = autoUpscaleStrength({
            scaleFactor: computeScaleFactor(controller),
            edgeEnergy: controller._contentSmoothedEdgeEnergy,
        });
    }
}

function smooth(prev, raw) {
    if (prev == null) return raw;
    return prev + (raw - prev) * CONTENT_SMOOTHING_FACTOR;
}

/* How much the source would need to be stretched to fill the display - same ratio
   renderShaderFrame computes for its own scale clamp (shader-pipeline.js), recomputed
   fresh here rather than cached since the window can resize mid-playback. Falls back to the
   media facade's videoWidth/videoHeight on Xbox, where there is no controller._videoEl - see
   core/media-facade.js's NativeMediaFacade, kept in sync from native's own loadedMetadata event. */
function computeScaleFactor(controller) {
    const video = controller._videoEl || media(controller);
    if (!video || !video.videoWidth || !video.videoHeight) return 1;
    const dpr = window.devicePixelRatio || 1;
    const displayW = (window.innerWidth || document.documentElement.clientWidth) * dpr;
    const displayH = (window.innerHeight || document.documentElement.clientHeight) * dpr;
    return Math.max(1, Math.min(displayW / video.videoWidth, displayH / video.videoHeight));
}

function averageSaturation(data) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        total += (max - min) / 255;
        count++;
    }
    return count ? total / count : 0;
}

/* Standard deviation of luma across the sampled frame, normalized to 0..1 - backs Auto
   Contrast (see shaders.js's autoContrastBoostStrength). A flat, washed-out/hazy frame
   has luma values clustered close together (low stdDev); a frame that already spans a
   wide tonal range has them spread out (high stdDev). Two passes (mean, then variance)
   rather than a running-sum-of-squares single pass - this runs once per ~750ms tick over
   a tiny 32x18 sample, not a hot per-frame path, so the extra pass isn't worth the
   numerical-stability tradeoff a single-pass formula would carry. */
function averageLumaStdDev(data) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
        total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        count++;
    }
    if (!count) return 0;
    const mean = total / count;
    let variance = 0;
    for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        variance += (luma - mean) * (luma - mean);
    }
    return Math.sqrt(variance / count) / 255;
}

/* Mean Sobel-style gradient magnitude across the sampled grid - same gx/gy math as
   SHADER_FRAGMENT_ANIME's edge detection (shaders.js), just run once in JS over this tiny
   bitmap instead of per-pixel in GLSL over the full frame. A high value means the frame
   already shows plenty of fine detail/edge content; autoUpscaleStrength uses it only to
   damp the resolution-driven sharpen need, not to override it (see that function's own
   comment for why: this can't distinguish real detail from noise). */
function averageEdgeEnergy(data, w, h) {
    const luma = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let total = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            const lN = luma(i - w * 4);
            const lS = luma(i + w * 4);
            const lW = luma(i - 4);
            const lE = luma(i + 4);
            const gx = lE - lW;
            const gy = lS - lN;
            total += Math.sqrt(gx * gx + gy * gy) / 255;
            count++;
        }
    }
    return count ? Math.min(1, (total / count) * 4) : 0;
}
