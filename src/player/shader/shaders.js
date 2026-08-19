import SHARPEN_ANIME_FRAG from "./glsl/sharpen-anime.frag.glsl?raw";
import SHARPEN_CAS_FRAG from "./glsl/sharpen-cas.frag.glsl?raw";
import PRESENT_FRAG from "./glsl/present.frag.glsl?raw";
import ANIME4K_RESTORE_CNN_S from "./glsl/vendor/anime4k-restore-cnn-s.glsl?raw";
import ANIME4K_UPSCALE_CNN_X2_S from "./glsl/vendor/anime4k-upscale-cnn-x2-s.glsl?raw";
import FSR1_EASU_RCAS from "./glsl/vendor/fsr1-easu-rcas.glsl?raw";
import LUMA_EXTRACT_FRAG from "./glsl/luma-extract.frag.glsl?raw";
import LUMA_MERGE_FRAG from "./glsl/luma-merge.frag.glsl?raw";
import DEBAND_FRAG from "./glsl/deband.frag.glsl?raw";
import { SOURCE } from "./pass-chain.js";
import { loadMpvUserShader, loadMpvUserShaderChain } from "./mpv-user-shader.js";

/* Web port of the Android shader-upscaling feature (ShaderType/ShaderTuning/
   ShaderUpscaleShaderProgram in android/.../PlayerActivity's Java sources) - same two
   GLSL algorithms and the same min/max tuning endpoints a 0-100% strength slider
   interpolates between, just running as a WebGL pass over the <video> element instead
   of inside ExoPlayer's native pipeline. See plex-player.js's _ensureShaderPipeline for
   how frames get from <video> to this shader.

   The GLSL itself now lives in ./glsl/*.glsl rather than as template literals here, so
   Android's leg can consume the exact same files off its assets/ directory instead of
   keeping a third hand-synced copy as Java string constants. Editing a shader means
   editing one file, not three. */

/* Sharpen/upscale knobs only - no saturation/contrast here anymore. Those used to be
   coupled to this same shader-type strength slider, but a linear contrast stretch
   pivoted at mid-gray crushes near-black shades into flat 0 once the boost multiplier
   rides high enough (confirmed: Anime4K's old 1.18x max crushed anything under ~7.6%
   luma to exact 0 post-clamp) - a shadow-detail bug that's inherent to that formula, not
   a tuning mistake. Plezy's own shader presets (NVScaler/ArtCNN/Anime4K) carry no
   contrast/saturation knobs at all for the same reason - sharpening and "look" grading
   are different concerns. See COLOR_BOOST_TUNING/colorBoostAt below for where
   contrast/saturation moved, as their own independent toggle. */

/* Deband knobs, in units that mean something: threshold and grain in 8-bit LSBs, range in source
   pixels. The original 1.0/1.5 here did nothing visible on real footage - a 1-LSB threshold
   assumes noiseless input, but real compression banding steps by more than 1 LSB and real
   footage carries enough grain/dither noise that almost nothing landed inside so tight a
   tolerance (confirmed by cranking to an absurd 12/24/20 as a diagnostic - that blended real
   detail and added obvious noise, proving the pass runs but was mistuned in both directions).
   mpv's own deband defaults translate to ~2/~3 LSB in these units, which was still too subtle
   on real playback - confirmed. Threshold doubled from that to actually smooth banding; grain
   left alone since it was never the complaint and doubling threshold alone already risks edging
   toward real-detail softening. */
export const DEBAND_TUNING = { threshold: 6.0, range: 12.0, grain: 1.0 };

/* Optional passes make a preset's chain a function of settings rather than a fixed array, so every
   preset is composed through here. Deband runs FIRST, at source resolution: it repairs the source
   before anything amplifies it, and running it after an upscaler would mean paying for it over
   2-4x the pixels while trying to fix banding the upscaler had already smeared.

   The `from` symbol handed to each preset's builder is what its algorithm passes should read -
   SOURCE normally, the deband pass when that is enabled. Presets take it as a parameter rather
   than hardcoding SOURCE, which is what makes them composable at all. */
function composePasses(buildAlgorithmPasses, options) {
    const deband = !!(options && options.deband);
    if (!deband) return buildAlgorithmPasses(SOURCE);
    return [
        { name: "deband", frag: DEBAND_FRAG, inputs: [{ uniform: "uTex", from: SOURCE }], scale: 1, float: "required" },
        ...buildAlgorithmPasses("deband"),
    ];
}

/* `passes` is this preset's pass chain, in execution order, for shader/pass-chain.js -
   see createPassChain for the descriptor shape. Both presets here are single-pass, which
   is what makes them identical to the pre-pass-chain implementation: one fragment shader
   sampling the source and rendering straight to the canvas. Multi-pass presets (the real
   CNN upscalers) declare several entries and may read SOURCE alongside an earlier pass. */
export const SHADER_TYPES = {
    anime4k: {
        label: "Animation",
        useCas: false,
        min: { scale: 1.8, sharpen: 1.8, kernel: 1.5 },
        max: { scale: 2.4, sharpen: 3.8, kernel: 2.8 },
        buildPasses: (opts) => composePasses((from) => [{ name: "sharpen", frag: SHARPEN_ANIME_FRAG, inputs: [{ uniform: "uTex", from }] }], opts),
        /* Rendered as anime4k_cnn instead wherever that chain builds (see shader-pipeline.js's
           resolveAvailablePreset). This stays the key detectShaderType returns and the key the
           bridge sends to Android/Xbox, both of which only know the two original families -
           upgrading here rather than in detectShaderType is what keeps the native contract
           untouched while the web leg renders the real CNN. */
        upgradeTo: "anime4k_cnn",
    },
    live_action: {
        label: "Live-Action",
        useCas: true,
        min: { scale: 1.3, sharpen: 1.0, kernel: 1.2 },
        max: { scale: 1.6, sharpen: 2.2, kernel: 1.8 },
        buildPasses: (opts) => composePasses((from) => [{ name: "sharpen", frag: SHARPEN_CAS_FRAG, inputs: [{ uniform: "uTex", from }] }], opts),
        /* Rendered as live_action_fsr instead wherever that chain builds - same family-key-stays-
           stable reasoning as anime4k's upgradeTo above. */
        upgradeTo: "live_action_fsr",
        /* CAS ramps to its max tuning by 15% strength instead of 100% - the old full
           0-100% range made the slider's first ~2/3 barely perceptible (see the weight-gate
           fix above), so the previous "100%" tuning now arrives at "Light" instead of only
           at "Strong". Strength above 0.15 just stays at max, same as reaching 100% used to. */
        rampToMaxAt: 0.15,
    },
};

/* Anime4K v4 "Mode A": the real Restore + 2x Upscale CNN chain, loaded straight from the
   vendored upstream files (see glsl/vendor/README.md). This is the preset that makes
   "AI upscaling" literal rather than a figure of speech - ~900 trained parameters across
   both files, as opposed to the hand-written edge-gated unsharp mask the anime4k family
   above runs.

   Built behind a try/catch and only registered on success: it needs WebGL2 plus float render
   targets, and a device without them should quietly keep the sharpen presets rather than
   lose shader upscaling entirely. `strengthless` is why the strength slider doesn't apply -
   a trained network has no intensity knob, same as the NVScaler/ArtCNN/Anime4K presets in
   the reference player. min/max are pinned to scale 2 (the chain's own fixed ratio) so the
   existing output-sizing math in renderShaderFrame needs no special case. */
try {
    /* Loaded per composition rather than once: with deband inserted, the CNN's MAIN has to start at
       the deband pass, and that symbol is resolved inside the loader (its WIDTH/HEIGHT expressions
       reference MAIN by name). Parsing is string work measured in single-digit ms and only happens
       when the deband toggle flips, so re-loading beats the indirection needed to patch symbols
       afterwards - which is exactly what caused the late-binding bug. */
    const buildAnime4kCnn = (from) => {
        const loaded = loadMpvUserShaderChain([
            { source: ANIME4K_RESTORE_CNN_S, name: "a4k-restore" },
            { source: ANIME4K_UPSCALE_CNN_X2_S, name: "a4k-upscale" },
        ], from);
        return [
            ...loaded.passes,
            { name: "present", frag: PRESENT_FRAG, inputs: [{ uniform: "uTex", from: loaded.passes[loaded.passes.length - 1].name }] },
        ];
    };
    /* Built once here so a load failure surfaces now rather than on first playback, and to give
       `when` a home. */
    const anime4kCnn = loadMpvUserShaderChain([
        { source: ANIME4K_RESTORE_CNN_S, name: "a4k-restore" },
        { source: ANIME4K_UPSCALE_CNN_X2_S, name: "a4k-upscale" },
    ]);
    SHADER_TYPES.anime4k_cnn = {
        label: "Animation (AI CNN)",
        strengthless: true,
        buildPasses: (opts) => composePasses(buildAnime4kCnn, opts),
        /* Anime4K's own //!WHEN clause, parsed out of the upstream files - "only run if the
           display is at least 1.2x the video in both axes". Below that the chain falls back to
           the cheap sharpen rather than spending 10 passes to not upscale. */
        when: anime4kCnn.when,
        fallbackTo: "anime4k",
        min: { scale: 2, sharpen: 0, kernel: 1 },
        max: { scale: 2, sharpen: 0, kernel: 1 },
    };
} catch (e) {
    console.error("StreamingPlayer: Anime4K CNN preset unavailable -", e.message);
}

/* AMD FidelityFX Super Resolution 1 (EASU edge-directed upscale + RCAS robust sharpen), the
   real published algorithm rather than the CAS-*inspired* single-pass sharpen the live_action
   family runs. Where Anime4K reconstructs line art with a trained network, EASU does analytic
   edge reconstruction - the right tool for photographic content, and what makes this the
   live-action counterpart rather than a second animation preset.

   Wrapped in the luma sub-pipeline: FSR's mpv port hooks LUMA and reads/writes only `.r`, so
   it gets a luma plane extracted for it and the result folded back into RGB afterwards. See
   luma-extract.frag.glsl for why that indirection is mandatory rather than an optimisation.

   `strengthless` because FSR's sharpness is a compile-time `#define SHARPNESS 0.2` inside the
   vendored file, not a uniform. Exposing it as a slider would mean either editing the vendored
   source (defeating the point of vendoring it verbatim) or injecting a conflicting #define, so
   it ships at upstream's default. */
try {
    const LUMA_EXTRACT_PASS = "luma-extract";
    const buildFsr = (from) => {
        const loaded = loadMpvUserShader(FSR1_EASU_RCAS, { name: "fsr1", inputSymbol: LUMA_EXTRACT_PASS });
        return [
            { name: LUMA_EXTRACT_PASS, frag: LUMA_EXTRACT_FRAG, inputs: [{ uniform: "uTex", from }], scale: 1, float: "required" },
            ...loaded.passes,
            {
                name: "luma-merge",
                frag: LUMA_MERGE_FRAG,
                inputs: [
                    /* The RGB half of the merge must read the same image the luma was extracted from, so
                       with deband on it is the debanded one - folding a repaired luma back into unrepaired
                       RGB would leave the banding in the chroma-carrying channels. */
                    { uniform: "uSource", from },
                    { uniform: "uLuma", from: loaded.passes[loaded.passes.length - 1].name },
                ],
            },
        ];
    };
    const fsr = loadMpvUserShader(FSR1_EASU_RCAS, { name: "fsr1", inputSymbol: LUMA_EXTRACT_PASS });
    SHADER_TYPES.live_action_fsr = {
        label: "Live-Action (FSR 1)",
        strengthless: true,
        /* FSR's own clause: run only if the output has more pixels than the source. Looser than
           Anime4K's 1.2x because EASU is far cheaper than a ten-pass CNN. */
        when: fsr.when,
        fallbackTo: "live_action",
        /* EASU's declared output caps at 2x the source, so there is no point sizing the canvas
           beyond that - matching the CNN preset's fixed ratio. */
        min: { scale: 2, sharpen: 0, kernel: 1 },
        max: { scale: 2, sharpen: 0, kernel: 1 },
        buildPasses: (opts) => composePasses(buildFsr, opts),
    };
} catch (e) {
    console.error("StreamingPlayer: FSR 1 preset unavailable -", e.message);
}

export function shaderTuningAt(shaderKey, strength) {
    const type = SHADER_TYPES[shaderKey];
    const rampToMaxAt = type.rampToMaxAt ?? 1;
    const t = Math.max(0, Math.min(1, strength / rampToMaxAt));
    const lerp = (a, b) => a + (b - a) * t;
    return {
        scale: lerp(type.min.scale, type.max.scale),
        sharpen: lerp(type.min.sharpen, type.max.sharpen),
        kernel: lerp(type.min.kernel, type.max.kernel),
    };
}

/* Contrast/saturation "look" boost - its own independent toggle (Color Boost, see
   shader-pipeline.js's setColorBoostEnabled/setColorBoostStrength), not tied to
   whichever shader-upscale algorithm this title's genre detected. Shares the same GL
   pass as shader upscaling (one frame, one GPU pass - see renderShaderFrame) but is
   otherwise unrelated: enabling this alone runs with sharpenStrength forced to 0, no
   upscale, purely the contrast/saturation lift below. */
export const COLOR_BOOST_TUNING = {
    min: { saturation: 1, contrast: 1 },
    max: { saturation: 1.3, contrast: 1.15 },
};

export function colorBoostAt(strength) {
    const t = Math.max(0, Math.min(1, strength));
    const lerp = (a, b) => a + (b - a) * t;
    return {
        saturation: lerp(COLOR_BOOST_TUNING.min.saturation, COLOR_BOOST_TUNING.max.saturation),
        contrast: lerp(COLOR_BOOST_TUNING.min.contrast, COLOR_BOOST_TUNING.max.contrast),
    };
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/* Auto-strength math for Shader Upscaling. scaleFactor is how much the source needs to
   be stretched to fill the display (1 = native res or larger, no upscale need beyond
   MIN_STRENGTH's own baseline below; higher = more upscale needed - see
   content-analysis.js/renderShaderFrame for how it's computed). edgeEnergy (0..1) is a
   Sobel-style "how much fine detail/edge content is already visible in this frame"
   measure from the same sampler - used only to *damp* the resolution-driven strength
   (DETAIL_DAMPEN_MAX caps how much), never to override it outright, since a blurry
   upscale transcode and a genuinely soft-focus native source are indistinguishable from
   edgeEnergy alone. MIN_STRENGTH is a baseline sharpen applied even at scaleFactor<=1 (a
   1080p source already filling a 1080p display, say) - a mild sharpen still visibly
   helps perceived clarity at native resolution, confirmed against real playback; an
   earlier version floored strength at exactly 0 whenever no *resolution-driven* upscale
   was needed, which read as "Auto does nothing" for the very common native-or-near-native
   case. Calibration constants below are a starting point, not exhaustively tuned against
   every kind of source - see this feature's own tuning notes. */
const UPSCALE_AUTO_MIN_STRENGTH = 0.15;
const UPSCALE_AUTO_RATIO_LOW = 1.0;
const UPSCALE_AUTO_RATIO_HIGH = 3.0;
const UPSCALE_AUTO_DETAIL_DAMPEN_MAX = 0.4;

export function autoUpscaleStrength({ scaleFactor, edgeEnergy }) {
    const ratioNeed = clamp((scaleFactor - UPSCALE_AUTO_RATIO_LOW) / (UPSCALE_AUTO_RATIO_HIGH - UPSCALE_AUTO_RATIO_LOW), 0, 1);
    const base = UPSCALE_AUTO_MIN_STRENGTH + ratioNeed * (1 - UPSCALE_AUTO_MIN_STRENGTH);
    const dampen = clamp(edgeEnergy, 0, 1) * UPSCALE_AUTO_DETAIL_DAMPEN_MAX;
    return clamp(base * (1 - dampen), 0, 1);
}

/* Auto-strength math for Color Boost. avgSaturation (0..1, 0 = fully gray, 1 = fully
   saturated) comes from averaging per-pixel (max-min)/255 across a sampled frame (see
   content-analysis.js) - dull/desaturated footage gets boosted more, already-vivid
   footage gets little to none. The original 0.15-0.55 range assumed real footage's
   average per-pixel saturation would span roughly that band - confirmed against real
   playback that it doesn't: typical (live-action) content (skin tones, muted grading,
   shadows/highlights near black/white where max-min is naturally small) averages well
   under 0.15 almost always, so the old range left strength pegged at or near 1 for
   nearly everything. Both thresholds moved down and the band narrowed so live-action
   content actually spreads across the range - confirmed working well.

   A MIN_STRENGTH floor (never drop below a light touch) was tried next for vividly-
   graded content that legitimately averages above SAT_HIGH (animation in particular),
   mirroring UPSCALE_AUTO_MIN_STRENGTH's own floor above - but confirmed that was the
   wrong fix here: it left strength pinned at the floor's exact value for any content
   whose saturation sits at or past SAT_HIGH, i.e. a flat non-varying reading rather than
   a real 0, and Color Boost already has its own on/off toggle for "I don't want this at
   all" - unlike Shader Upscaling, where a mild sharpen is broadly beneficial even at
   native resolution and a literal 0 was the actual bug. A genuinely vivid frame
   legitimately warrants 0 boost, not a floored minimum. */
const COLOR_BOOST_AUTO_SAT_LOW = 0.04;
const COLOR_BOOST_AUTO_SAT_HIGH = 0.2;

export function autoColorBoostStrength({ avgSaturation }) {
    return clamp((COLOR_BOOST_AUTO_SAT_HIGH - avgSaturation) / (COLOR_BOOST_AUTO_SAT_HIGH - COLOR_BOOST_AUTO_SAT_LOW), 0, 1);
}

/* Picks which of the two SHADER_TYPES algorithms suits a title, from its Plex genre
   tags - Anime4K's edge-gated line-art shader for anything animated (matches "Animation"
   and "Anime" alike, Western or Japanese), CAS everywhere else. Both platforms (this
   file and Android's PlayerActivity) get this same result computed once here rather
   than duplicating the genre check in Java - see plex-player.js's _playNative. */
export function detectShaderType(genres) {
    const isAnimated = (genres || []).some((g) => (g || "").toLowerCase().includes("anim"));
    return isAnimated ? "anime4k" : "live_action";
}

/* Re-exported under their historical names so the Android/Xbox ports keep one obvious
   place to point at when their own comments say "same shader as the web leg". The vertex
   shader moved into pass-chain.js, which needs to pick between the GLSL ES 1.00 and 3.00
   variants per pass anyway. */
export { SHARPEN_ANIME_FRAG as SHADER_FRAGMENT_ANIME, SHARPEN_CAS_FRAG as SHADER_FRAGMENT_CAS };

/* Every preset above declares `buildPasses`; `passes` is its no-optional-passes composition,
   materialised once. Kept because it is the shape the tests assert against and the natural thing
   to read for "what does this preset consist of" - while the built chain's own passCount is what
   the UI reports at runtime, since that reflects the composition actually in use. */
for (const preset of Object.values(SHADER_TYPES)) {
    preset.passes = preset.buildPasses({ deband: false });
}