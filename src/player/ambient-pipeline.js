import { AMBIENT_STORAGE_KEY, AMBIENT_OPACITY_STORAGE_KEY } from "./ui/shared.js";
import { hasNativePlayer, platformTag } from "./core/platform.js";
import { media } from "./core/media-facade.js";
/* Circular with xbox-bridge.js (which imports applyXboxAmbientColors/teardownAmbient from this
   file, while this file imports postAmbientLighting from it) - safe for the same reason as the
   other cycles in src/player/: postAmbientLighting is only referenced inside updateAmbientPipeline's
   function body below, never at module-evaluation time. */
import { postAmbientLighting } from "./xbox-bridge.js";

function isXbox() {
    return hasNativePlayer() && platformTag() === "xbox";
}

/* Ambient-lighting pipeline (web/Xbox only - Android's native ExoPlayer leg has its own
   equivalent built from AmbientLightSampler/AmbientGlowView in the android/ project,
   since native playback renders in a separate Activity outside this WebView entirely,
   the same wall documented for shader upscaling in docs/plezy-player-comparison.md).
   Takes the StreamingPlayerController instance as an explicit first argument (same
   "mixin function" pattern as shader-pipeline.js/native-bridge.js/web-fallback.js)
   rather than owning a private copy of the video/canvas state.

   Samples the controller's own <video> element into a tiny offscreen 2D canvas each
   tick, averages its four edge strips into RGB colors, and paints those onto four
   blurred glow panels sitting behind the video. Deliberately does NOT resize or zoom
   the video at all - it only fills whatever letterbox/pillarbox gap the video's own
   object-fit:contain already leaves when its aspect ratio doesn't match the viewport's.
   If the video's aspect ratio happens to match the viewport exactly, there's no gap and
   ambient lighting is a no-op visually, which is intentional (an earlier version
   artificially shrank the video to manufacture a margin for every video - reverted since
   that reads as an unwanted zoom rather than "fill the black bars that are already
   there").

   Two things have to both be true for the glow to actually show through that gap,
   not just be correctly positioned behind it:
   - The four glow panels have to be sized to the video's own *rendered picture* rect
     (computePictureRect), not a fixed fraction of the viewport - the gap's size depends
     entirely on how far the video's own aspect ratio is from the viewport's.
   - The video element's own `background` has to be transparent while ambient lighting
     is on, not the opaque "#000" web-fallback.js normally sets - a <video> is a
     replaced element like <img>, so object-fit:contain's letterbox area is painted by
     the element's own background, sitting *above* the glow-container in z-order (see
     ensureAmbientPipeline). The shader-upscaling canvas needs the same treatment
     whenever it's also active, since it visually replaces the (opacity:0'd) video in
     that case - see updateAmbientPipeline and shader-pipeline.js's ensureShaderPipeline. */

const AMBIENT_SAMPLE_INTERVAL_MS = 42;
const AMBIENT_SAMPLE_W = 32;
const AMBIENT_SAMPLE_H = 18;
const AMBIENT_EDGE_FRACTION = 0.25;
/* filter:blur() averages in "nothing" (fully transparent) from just outside an
   element's own box when blurring pixels near its edge - true on both sides of each
   wrapper, not just the outer (true viewport edge) side the blur-radius comment below
   discusses. On the INNER side (toward the picture), that diluted/darkened blur-edge
   read as a visible shadow hugging the video's own boundary, sitting right on top of
   the ambient glow (confirmed by disabling blur - the shadow vanished immediately).
   layoutGlowPanels extends each wrapper this many px into the picture's own side (fully
   hidden there behind the opaque video, itself on top in z-order) and glowGradient
   shifts its stops by the same amount, so blur has real, correctly-colored, opaque
   margin to sample near that edge instead of transparency - eliminating the artifact
   without touching the *outer* edge's own (already-intended, already-tuned) fade-out. */
const AMBIENT_BLUR_PX = 36;
/* Zones per edge, like a real Ambilight strip's discrete LED segments rather than one
   flat averaged color per side - each edge is split into this many equal cells along its
   own length, each independently sampled/colored. AMBIENT_BLUR_PX's blur is applied to
   the whole per-edge wrapper (not per zone) specifically so it blends adjacent zones'
   colors into each other, not just softening each zone's own inner fade. */
const AMBIENT_ZONES_PER_EDGE = 8;
/* A plain average of a real video frame's edge pixels tends to read as dull/grayish -
   many differently-colored/lit pixels blending together pulls the result toward gray
   regardless of how vivid the scene actually looks. Boosted the same way
   shaders.js's SHADER_FRAGMENT_CAS pushes its own saturation/contrast: each channel is
   moved further from (SATURATION_BOOST) or closer to (BRIGHTNESS_BOOST scales all three
   together) the sampled luma, not converted through HSV - same algebra, far less code. */
const AMBIENT_SATURATION_BOOST = 1.6;
const AMBIENT_BRIGHTNESS_BOOST = 1.3;
/* Temporal smoothing (an exponential moving average per zone/channel, applied in
   smoothZones below), distinct from each zone's own CSS transition above -
   the transition only smooths how a single target color gets *rendered*, but every new
   raw sample still becomes that target every tick, so a noisy/flickery raw sample (film
   grain, a single stray bright frame, compression artifacts) still shows up, just with a
   short render lag. This instead damps the noise out of the color *data* itself, same
   idea as a real Ambilight/Hue Sync box's own "smoothing" setting. 1.0 would disable
   smoothing entirely (each sample fully replaces the last); lower values damp harder at
   the cost of lagging further behind real scene changes. */
const AMBIENT_SMOOTHING_FACTOR = 0.3;
/* Fixed reach (not scaled to the actual letterbox/pillarbox gap size) - lets the glow's
   own falloff distance stay constant regardless of how large or small a given video's
   gap happens to be, rather than always spanning exactly picture-edge-to-viewport-edge.
   A gap narrower than this only shows the falloff curve's early, still-bright portion
   instead of squeezing a full fade into a tiny span; a gap wider than this lets the glow
   fully fade to black before reaching the true viewport edge, leaving a plain black band
   beyond its own reach - both intentional, matching how a real light source's glow
   doesn't stretch to always exactly reach the far wall. CSS gradient stop positions
   support raw px (not just %), so this works as a literal, viewport-size-independent
   distance the same way AMBIENT_BLUR_PX's own blur radius above already is. */
const AMBIENT_GLOW_REACH_PX = 240;
/* Sampled points along a cosine ease (0.5*(1+cos(pi*t))) rather than a flat-hold-then-
   linear-drop - continuously eases from full opacity to fully transparent with no kink
   where two different slopes met, which read as an unnaturally sudden cutoff. */
const AMBIENT_FALLOFF_STEPS = 8;

/* The "more" menu's inline toggle (see chrome.js's openHamburgerMenu) - unlike shader
   upscaling's toggle, this one IS the persisted setting (see storedAmbientEnabled's own
   comment), so flipping it writes through to localStorage immediately rather than only
   ever changing in-memory session state. */
export function setAmbientEnabled(controller, enabled) {
    controller._ambientEnabled = enabled;
    localStorage.setItem(AMBIENT_STORAGE_KEY, enabled ? "1" : "0");
    updateAmbientPipeline(controller);
}

/* Same immediate-persistence model as setAmbientEnabled above - see
   storedAmbientOpacity's own comment for why this isn't the Settings-modal
   tiered-preset model shader strength uses. Applied as each wrapper's own CSS
   `opacity` (a compositing-level scalar on top of whatever alpha the gradient itself
   already carries), not baked into the sampled color - keeps the container's own
   permanently-opaque black background (see ensureAmbientPipeline) as the fallback this
   dims *toward*, not something this fades away too. */
export function setAmbientOpacity(controller, opacity) {
    controller._ambientOpacity = opacity;
    localStorage.setItem(AMBIENT_OPACITY_STORAGE_KEY, String(opacity));
    applyAmbientOpacity(controller);
}

function applyAmbientOpacity(controller) {
    const panels = controller._ambientGlowPanels;
    if (!panels) return;
    const opacity = String(controller._ambientOpacity ?? 0.5);
    Object.values(panels).forEach((p) => {
        p.wrapper.style.opacity = opacity;
    });
}

export function updateAmbientPipeline(controller) {
    const xbox = isXbox();
    /* Native only has a sampling job here (the color-averaging, done off the same decoded frame
       ShaderVideoEffect already has in hand) - the panels themselves are pure DOM, painted below
       exactly as on web, since there is no way for a native surface to layer into the page. */
    if (xbox) postAmbientLighting(!!controller._ambientEnabled);

    if (!controller._ambientEnabled) {
        stopAmbientLoop(controller);
        if (controller._ambientGlowContainer) controller._ambientGlowContainer.style.display = "none";
        if (controller._videoEl) controller._videoEl.style.background = "#000";
        if (controller._shaderCanvas) controller._shaderCanvas.style.background = "#000";
        return;
    }
    if (!ensureAmbientPipeline(controller)) {
        controller._ambientEnabled = false;
        return;
    }
    controller._ambientGlowContainer.style.display = "block";
    if (controller._videoEl) controller._videoEl.style.background = "transparent";
    if (controller._shaderCanvas) controller._shaderCanvas.style.background = "transparent";
    layoutGlowPanels(controller);
    /* Xbox never starts this loop - there is no <video> for renderAmbientFrame to sample, and
       layoutGlowPanels is instead re-run each time a fresh "ambientColors" event arrives (see
       applyXboxAmbientColors below) plus once here for the initial layout. */
    if (!xbox) startAmbientLoop(controller);
}

/* Two nested elements per edge, not one. The blur filter needs real, opaque content past the
   picture's own true edge to sample near that boundary (see AMBIENT_BLUR_PX's own comment for
   why - without it, blur dilutes in transparency from beyond the box and reads as a shadow right
   at the edge) - true on every platform. But that overscan content must never actually be visible
   over the real picture, and web/Xbox differ in how that gets enforced: web's opaque <video>
   element sits above this whole tree in z-order and simply covers it; Xbox has no such element at
   all (native video renders in a separate XAML layer, entirely outside CSS z-index), so nothing
   would hide it there.
   `clip` is sized to the TRUE gap only (see layoutGlowPanels) with overflow:hidden, and never
   grows past it. `wrapper` - still the full gap+overscan size the blur needs - is its child,
   positioned so the overscan portion always lands outside clip's own box and gets cut off by it.
   This is a plain CSS clip, not a platform check: it produces the exact same rendered result on
   web (that overscan region was already invisible there too, just via z-order instead of
   clipping) while actually fixing Xbox, where a viewer could otherwise see it visibly overlapping
   real video ("ambient lighting is overlaying the main video", confirmed on hardware). */
function makeGlowEdge(edge) {
    const clip = document.createElement("div");
    Object.assign(clip.style, {
        position: "fixed",
        overflow: "hidden",
        pointerEvents: "none",
    });

    const wrapper = document.createElement("div");
    const gradientDir = { top: "to top", bottom: "to bottom", left: "to left", right: "to right" }[edge];
    Object.assign(wrapper.style, {
        /* Relative to `clip` (its nearest positioned ancestor), not the viewport - layoutGlowPanels
           positions clip in viewport coordinates and wrapper relative to clip's own box. */
        position: "absolute",
        display: "flex",
        flexDirection: edge === "top" || edge === "bottom" ? "row" : "column",
        /* Smaller than an earlier version's blur(80px) - a heavy blur diffuses color
           out past a narrow gap's own edges (there's nothing but transparency beyond
           the panel's own box for the blur to pull in), which for a typical letterbox
           gap only a few dozen px tall diluted most of the color away entirely. The
           gradient's own cosine-eased falloff (see glowGradient) does most of the
           softening now. */
        filter: `blur(${AMBIENT_BLUR_PX}px)`,
        pointerEvents: "none",
    });
    const zones = [];
    for (let i = 0; i < AMBIENT_ZONES_PER_EDGE; i++) {
        const zone = document.createElement("div");
        /* Kept proportional to AMBIENT_SAMPLE_INTERVAL_MS (roughly 1.3x it, same ratio
           as the original 0.2s/150ms) rather than left at a fixed duration - a
           transition much longer than the sampling interval smooths over several
           samples' worth of real color change at once, reading as lag behind the actual
           video rather than a soft blend of adjacent frames. */
        Object.assign(zone.style, { flex: "1 1 0%", transition: "background 0.06s linear" });
        /* Color at the edge nearest the picture, fading out over a fixed distance (see
           AMBIENT_GLOW_REACH_PX) rather than necessarily all the way to the viewport
           edge - e.g. a top-zone's "to top" gradient axis starts (full color) at its own
           bottom (the picture's top edge, wherever layoutGlowPanels puts it) and eases
           toward transparent going up from there, matching how a physical Ambilight
           TV's glow is brightest right at the screen and fades into the room beyond it -
           not the other way around. */
        zone.dataset.gradientDir = gradientDir;
        wrapper.appendChild(zone);
        zones.push(zone);
    }
    clip.appendChild(wrapper);
    return { clip, wrapper, zones };
}

/* Lazily built on first enable, same reasoning as ensureShaderPipeline - most sessions
   never touch this menu. The container's own #000 background is the fallback for
   whatever sliver of the video's letterbox gap the four edge gradients don't reach
   (mainly the corners, where two panels already overlap and blend anyway); it sits at a
   lower z-index than the video (10000, see web-fallback.js/shader-pipeline.js) so it's
   only visible at all once the video's own background goes transparent (see
   updateAmbientPipeline) within whatever gap object-fit:contain leaves. */
export function ensureAmbientPipeline(controller) {
    if (controller._ambientGlowContainer) return true;
    /* Web needs a real <video> to sample from; Xbox needs nothing here at all - its color data
       arrives over the bridge instead (see applyXboxAmbientColors below), so the panels can be
       built with no video element in hand. */
    if (!isXbox() && !controller._videoEl) return false;

    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "fixed",
        inset: "0",
        zIndex: "9990",
        /* "#000" on web only, where this container sits BEHIND the opaque <video> element (see
           this function's own header comment) - the fallback is invisible everywhere except the
           corners of the true letterbox gap the four edge gradients don't quite reach. Xbox has no
           DOM video element to occlude it: native video renders in a completely separate XAML
           visual layer behind the transparent WebView2, entirely outside CSS z-index, so an
           opaque full-screen background here would paint over the ENTIRE picture, not just the
           gap - confirmed on hardware ("ambient lighting borders generate live" but "the middle is
           solid black"). Xbox's own MediaPlayerElement (Stretch=Uniform) already letterboxes with
           its own black bars, so this container needs no fallback color of its own there. */
        background: isXbox() ? "transparent" : "#000",
        overflow: "hidden",
        pointerEvents: "none",
    });
    const panels = {
        top: makeGlowEdge("top"),
        bottom: makeGlowEdge("bottom"),
        left: makeGlowEdge("left"),
        right: makeGlowEdge("right"),
    };
    Object.values(panels).forEach((p) => container.appendChild(p.clip));
    document.body.appendChild(container);

    /* Xbox supplies zone colors over the bridge (see applyXboxAmbientColors below) - there is no
       <video> for a canvas to sample here, so skip building one entirely rather than fail the
       whole pipeline over a resource this platform never uses. */
    if (!isXbox()) {
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = AMBIENT_SAMPLE_W;
        sampleCanvas.height = AMBIENT_SAMPLE_H;
        const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
            console.error("StreamingPlayer: 2D canvas unavailable, ambient lighting disabled");
            container.remove();
            return false;
        }
        controller._ambientSampleCanvas = sampleCanvas;
        controller._ambientSampleCtx = ctx;
    }

    controller._ambientGlowContainer = container;
    controller._ambientGlowPanels = panels;
    applyAmbientOpacity(controller);
    controller._ambientLastSampleAt = 0;
    /* Per-zone EMA state for applySmoothedZoneColors (see AMBIENT_SMOOTHING_FACTOR) -
       null entries mean "no real sample seen yet for this zone", so the first sample
       becomes the initial value outright instead of fading in from black. */
    controller._ambientSmoothed = {
        top: new Array(AMBIENT_ZONES_PER_EDGE).fill(null),
        bottom: new Array(AMBIENT_ZONES_PER_EDGE).fill(null),
        left: new Array(AMBIENT_ZONES_PER_EDGE).fill(null),
        right: new Array(AMBIENT_ZONES_PER_EDGE).fill(null),
    };
    return true;
}

/* Where the video's own object-fit:contain fits its actual picture within the full
   viewport - mirrors the browser's own contain-fit math since there's no DOM API that
   reports it back directly. Equal to the full viewport whenever the video's aspect
   ratio already matches it (no letterboxing, nothing to fill). Falls back to assuming
   no letterboxing before video.videoWidth/videoHeight are known yet; self-corrects on
   the next animation frame once they are (see layoutGlowPanels's caller in
   startAmbientLoop). */
function computePictureRect(controller) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    /* Cover/Stretch (see chrome-menu-options.js's applyFitMode) fill the viewport exactly by
       definition - no letterbox gap exists for the glow to show in, regardless of the video's
       own aspect ratio, so there's nothing for the object-fit:contain math below to do. */
    if (controller._fitMode && controller._fitMode !== "fit") {
        return { left: 0, top: 0, width: vw, height: vh };
    }
    /* Falls back to the media facade's videoWidth/videoHeight on Xbox, where there is no
       controller._videoEl - see core/media-facade.js's NativeMediaFacade, kept in sync from
       native's own loadedMetadata event. */
    const video = controller._videoEl || media(controller);
    const viewportAR = vw / vh;
    const videoAR = video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : viewportAR;
    let w;
    let h;
    if (videoAR > viewportAR) {
        w = vw;
        h = vw / videoAR;
    } else {
        h = vh;
        w = vh * videoAR;
    }
    return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

/* Sizes each glow panel to span from the true viewport edge to the picture's own edge,
   plus AMBIENT_BLUR_PX further into the picture's own side (see that constant's own
   comment for why - blur-edge dilution, not a layout need) - variable per side, since it
   depends entirely on how far the video's own aspect ratio is from the viewport's.
   Cheap enough to run every animation frame (a handful of multiplications, no canvas
   work) rather than throttled like renderAmbientFrame's own color sampling below -
   keeps the panels responsive to window resizes and to video.videoWidth/videoHeight
   only becoming known a frame or two after playback starts. */
function layoutGlowPanels(controller) {
    const panels = controller._ambientGlowPanels;
    if (!panels) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = computePictureRect(controller);
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    /* Real gap per side, before any AMBIENT_BLUR_PX overscan is added - computePictureRect
       always makes at least one axis come out exactly 0 (object-fit:contain never
       leaves a gap on both axes at once, only whichever one doesn't match the
       viewport's own AR), so a video is letterboxed/pillarboxed on one axis pair far
       more often than not. Overscan must only extend a side that actually *has* a gap -
       adding it unconditionally (an earlier version of this fix did) made the
       already-zero-height/width side of a plain pillarboxed/letterboxed video
       AMBIENT_BLUR_PX tall/wide anyway, and any tiny mismatch between this computed
       rect and the browser's real object-fit:contain rendering let a full-width/height
       bright streak leak through right across the video itself on that side. */
    const topGap = Math.max(0, rect.top);
    const bottomGap = Math.max(0, vh - bottom);
    const leftGap = Math.max(0, rect.left);
    const rightGap = Math.max(0, vw - right);

    /* clip is sized to the TRUE gap only, in viewport coordinates - never overscan, and never more
       than the real gap. When a side has no gap at all, clip collapses to 0 and hides its wrapper
       entirely regardless of what the wrapper itself wants to paint - this is what makes it safe to
       give wrapper a flat, unconditional gap+AMBIENT_BLUR_PX size below instead of the three-way
       `gap > 0 ? gap + overscan : 0` ternary an earlier version needed (back when there was no clip
       to enforce true visibility, a zero-gap side given any height at all could leak a bright
       streak across the video on the slightest mismatch between this computed rect and the
       browser's real object-fit:contain rendering - see the git history for that fix). wrapper is
       positioned relative to clip (its nearest positioned ancestor - see makeGlowEdge), not the
       viewport, so its offsets below are deliberately DIFFERENT numbers from clip's own. */
    Object.assign(panels.top.clip.style, { left: "0px", top: "0px", width: `${vw}px`, height: `${topGap}px` });
    Object.assign(panels.top.wrapper.style, {
        left: "0px", top: "0px", width: `${vw}px`, height: `${topGap + AMBIENT_BLUR_PX}px`,
    });

    Object.assign(panels.bottom.clip.style, {
        left: "0px", top: `${vh - bottomGap}px`, width: `${vw}px`, height: `${bottomGap}px`,
    });
    Object.assign(panels.bottom.wrapper.style, {
        left: "0px", top: `${-AMBIENT_BLUR_PX}px`, width: `${vw}px`, height: `${bottomGap + AMBIENT_BLUR_PX}px`,
    });

    Object.assign(panels.left.clip.style, { left: "0px", top: "0px", width: `${leftGap}px`, height: `${vh}px` });
    Object.assign(panels.left.wrapper.style, {
        left: "0px", top: "0px", width: `${leftGap + AMBIENT_BLUR_PX}px`, height: `${vh}px`,
    });

    Object.assign(panels.right.clip.style, {
        left: `${vw - rightGap}px`, top: "0px", width: `${rightGap}px`, height: `${vh}px`,
    });
    Object.assign(panels.right.wrapper.style, {
        left: `${-AMBIENT_BLUR_PX}px`, top: "0px", width: `${rightGap + AMBIENT_BLUR_PX}px`, height: `${vh}px`,
    });
}

export function startAmbientLoop(controller) {
    if (controller._ambientRafId) return;
    const step = (ts) => {
        layoutGlowPanels(controller);
        renderAmbientFrame(controller, ts);
        controller._ambientRafId = requestAnimationFrame(step);
    };
    controller._ambientRafId = requestAnimationFrame(step);
}

export function stopAmbientLoop(controller) {
    if (controller._ambientRafId) {
        cancelAnimationFrame(controller._ambientRafId);
        controller._ambientRafId = null;
    }
}

/* Throttled to AMBIENT_SAMPLE_INTERVAL_MS rather than every animation frame - ambient
   light doesn't need 60fps tracking to look convincing, and drawImage+getImageData is
   real CPU work even at this tiny resolution, not worth spending on frames where the
   change would be imperceptible anyway. (layoutGlowPanels, called alongside this from
   startAmbientLoop's step(), isn't throttled the same way - it's cheap arithmetic with
   no canvas work, so it stays responsive to resizes every frame.) */
function renderAmbientFrame(controller, timestamp) {
    const video = controller._videoEl;
    const ctx = controller._ambientSampleCtx;
    if (!video || !ctx || video.readyState < video.HAVE_CURRENT_DATA) return;
    if (timestamp - controller._ambientLastSampleAt < AMBIENT_SAMPLE_INTERVAL_MS) return;
    controller._ambientLastSampleAt = timestamp;

    let data;
    try {
        ctx.drawImage(video, 0, 0, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_H);
        data = ctx.getImageData(0, 0, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_H).data;
    } catch (e) {
        /* Tainted-canvas SecurityError, same CORS invariant shader-pipeline.js's
           renderShaderFrame relies on - fail by turning ambient lighting back off
           instead of throwing on every animation frame. */
        console.error("StreamingPlayer: ambient lighting disabled - video frame is cross-origin tainted", e);
        controller._ambientEnabled = false;
        updateAmbientPipeline(controller);
        return;
    }

    const edgeRows = Math.max(1, Math.round(AMBIENT_SAMPLE_H * AMBIENT_EDGE_FRACTION));
    const edgeCols = Math.max(1, Math.round(AMBIENT_SAMPLE_W * AMBIENT_EDGE_FRACTION));
    const { top, bottom, left, right } = controller._ambientGlowPanels;
    const smoothed = controller._ambientSmoothed;
    applyZoneColors(top, smoothZones(smoothed.top, sampleZones(data, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_W, edgeRows, true, true)));
    applyZoneColors(bottom, smoothZones(smoothed.bottom, sampleZones(data, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_W, edgeRows, true, false)));
    applyZoneColors(left, smoothZones(smoothed.left, sampleZones(data, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_H, edgeCols, false, true)));
    applyZoneColors(right, smoothZones(smoothed.right, sampleZones(data, AMBIENT_SAMPLE_W, AMBIENT_SAMPLE_H, edgeCols, false, false)));
}

/* Exponential moving average per zone/channel - see AMBIENT_SMOOTHING_FACTOR's own
   comment for why this exists alongside (not instead of) each zone's CSS transition.
   Mutates prevZones' entries in place (the persisted EMA state travels with the
   controller across ticks) and returns the same arrays, now nudged toward this tick's
   raw sample, for immediate use as this frame's actual display color. */
function smoothZones(prevZones, rawZones) {
    return rawZones.map((raw, i) => {
        const prev = prevZones[i];
        if (!prev) {
            prevZones[i] = raw;
            return raw;
        }
        prev[0] += (raw[0] - prev[0]) * AMBIENT_SMOOTHING_FACTOR;
        prev[1] += (raw[1] - prev[1]) * AMBIENT_SMOOTHING_FACTOR;
        prev[2] += (raw[2] - prev[2]) * AMBIENT_SMOOTHING_FACTOR;
        return prev;
    });
}

function applyZoneColors(edgePanel, colors) {
    edgePanel.zones.forEach((zone, i) => {
        zone.style.background = glowGradient(zone.dataset.gradientDir, colors[i]);
    });
}

/* Splits one edge's own length (its width for top/bottom, its height for left/right)
   into AMBIENT_ZONES_PER_EDGE equal slices and averages each independently - same
   region-averaging as averageRegion below, just repeated per zone instead of once
   across the whole edge. */
function sampleZones(data, stride, axisLen, thickness, isHorizontalEdge, atStart) {
    const colors = [];
    for (let i = 0; i < AMBIENT_ZONES_PER_EDGE; i++) {
        const a0 = Math.round((i * axisLen) / AMBIENT_ZONES_PER_EDGE);
        const a1 = Math.round(((i + 1) * axisLen) / AMBIENT_ZONES_PER_EDGE);
        const len = Math.max(1, a1 - a0);
        if (isHorizontalEdge) {
            const y0 = atStart ? 0 : AMBIENT_SAMPLE_H - thickness;
            colors.push(averageRegion(data, stride, a0, y0, len, thickness));
        } else {
            const x0 = atStart ? 0 : AMBIENT_SAMPLE_W - thickness;
            colors.push(averageRegion(data, stride, x0, a0, thickness, len));
        }
    }
    return colors;
}

/* Explicit px stop positions (not %, unlike a plain 0%-100% fade) so the fade's own
   distance is fixed at AMBIENT_GLOW_REACH_PX regardless of the panel's own box size -
   see that constant's own comment. Each stop's alpha follows a cosine ease rather than
   the old flat-hold-then-linear-drop shape. Beyond the last stop's own position, the
   gradient holds that stop's (fully transparent) color automatically - CSS's normal
   behavior for any point past a gradient's final explicit stop - which is exactly the
   "plain black beyond the glow's own reach" effect when the panel's box is larger than
   AMBIENT_GLOW_REACH_PX. All positions are offset by AMBIENT_BLUR_PX to match
   layoutGlowPanels' own overscan - CSS holds the *first* stop's color for anything
   before its own position too, so this doesn't shift where full-opacity visually starts
   (still the true picture edge), it just gives that same full-opacity color real,
   non-transparent margin for AMBIENT_BLUR_PX worth of blur to sample from. */
function glowGradient(direction, [r, g, b]) {
    const stops = [];
    for (let i = 0; i < AMBIENT_FALLOFF_STEPS; i++) {
        const t = i / (AMBIENT_FALLOFF_STEPS - 1);
        const alpha = 0.5 * (1 + Math.cos(Math.PI * t));
        const pos = AMBIENT_BLUR_PX + t * AMBIENT_GLOW_REACH_PX;
        stops.push(`rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)}) ${pos.toFixed(1)}px`);
    }
    return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

function averageRegion(data, stride, x0, y0, w, h) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
            const i = (y * stride + x) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }
    }
    if (!count) return [0, 0, 0];
    return boostColor(r / count, g / count, b / count);
}

function clamp255(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

/* Pushes each channel further from (AMBIENT_SATURATION_BOOST) the sampled luma, then
   scales all three up together (AMBIENT_BRIGHTNESS_BOOST) - same algebra as
   shaders.js's SHADER_FRAGMENT_CAS post-sharpen contrast/saturation lift
   (`mix(vec3(luma), outColor, saturationBoost)`), just in plain JS instead of GLSL. A
   flat average of a real frame's edge pixels reads as dull/grayish on its own; this
   makes it look like the vivid color it's actually sampled from. */
function boostColor(r, g, b) {
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const boost = (c) => clamp255((luma + (c - luma) * AMBIENT_SATURATION_BOOST) * AMBIENT_BRIGHTNESS_BOOST);
    return [boost(r), boost(g), boost(b)];
}

/* Fed by ShaderVideoEffect's native sampler via xbox-bridge.js's "ambientColors" event - raw
   per-zone RGB averages only (see AmbientColorSampler.cs's own header for why). boostColor and
   smoothZones below are the exact same functions renderAmbientFrame's web path already calls,
   applied here in the same order (average -> boost -> smooth -> paint) so the two platforms
   produce the same look from the same source. */
export function applyXboxAmbientColors(controller, rawColors) {
    if (!controller._ambientGlowPanels || !controller._ambientSmoothed) return;
    layoutGlowPanels(controller);
    const toBoostedTriples = (flat) => {
        const out = [];
        for (let i = 0; i < flat.length; i += 3) out.push(boostColor(flat[i], flat[i + 1], flat[i + 2]));
        return out;
    };
    const { top, bottom, left, right } = controller._ambientGlowPanels;
    const smoothed = controller._ambientSmoothed;
    applyZoneColors(top, smoothZones(smoothed.top, toBoostedTriples(rawColors.top)));
    applyZoneColors(bottom, smoothZones(smoothed.bottom, toBoostedTriples(rawColors.bottom)));
    applyZoneColors(left, smoothZones(smoothed.left, toBoostedTriples(rawColors.left)));
    applyZoneColors(right, smoothZones(smoothed.right, toBoostedTriples(rawColors.right)));
}

/* Called from web-fallback.js's teardownWeb alongside teardownShaderPipeline and
   teardownContentAnalysis - same reasoning, this session's GL/canvas/DOM resources don't
   outlive the <video> they sample from. Doesn't need to restore the video's own background -
   teardownWeb removes the video element entirely right after. */
export function teardownAmbient(controller) {
    stopAmbientLoop(controller);
    if (controller._ambientGlowContainer) {
        controller._ambientGlowContainer.remove();
        controller._ambientGlowContainer = null;
    }
    controller._ambientGlowPanels = null;
    controller._ambientSampleCanvas = null;
    controller._ambientSampleCtx = null;
    controller._ambientSmoothed = null;
}