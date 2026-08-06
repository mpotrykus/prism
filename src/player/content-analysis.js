import { autoUpscaleStrength, autoColorBoostStrength } from "./shader/shaders.js";

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
    if (!controller._upscaleAuto && !controller._colorBoostAuto) {
        stopContentAnalysisLoop(controller);
        return;
    }
    if (!ensureContentAnalysis(controller)) return;
    startContentAnalysisLoop(controller);
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
           shader-pipeline.js rely on - fail by turning both auto modes back off instead
           of throwing on every animation frame. */
        console.error("StreamingPlayer: auto strength disabled - video frame is cross-origin tainted", e);
        controller._upscaleAuto = false;
        controller._colorBoostAuto = false;
        stopContentAnalysisLoop(controller);
        return;
    }

    const rawSaturation = averageSaturation(data);
    const rawEdgeEnergy = averageEdgeEnergy(data, CONTENT_SAMPLE_W, CONTENT_SAMPLE_H);
    controller._contentSmoothedSaturation = smooth(controller._contentSmoothedSaturation, rawSaturation);
    controller._contentSmoothedEdgeEnergy = smooth(controller._contentSmoothedEdgeEnergy, rawEdgeEnergy);

    if (controller._colorBoostAuto) {
        controller._autoColorBoostStrength = autoColorBoostStrength({ avgSaturation: controller._contentSmoothedSaturation });
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
   fresh here rather than cached since the window can resize mid-playback. */
function computeScaleFactor(controller) {
    const video = controller._videoEl;
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
