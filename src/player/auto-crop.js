import { AUTO_CROP_STORAGE_KEY } from "./ui/shared.js";
/* Circular with chrome-menu-options.js (which imports applyAutoCropGeometry from this
   file for its applyFitMode) - safe for the same reason every other cycle in ui/ is: see
   that file's own comment on cssObjectFitFor for why. */
import { cssObjectFitFor } from "./ui/chrome-menu-options.js";

/* Auto-Crop: detects black bars baked directly into the decoded video frame (as opposed
   to the outer letterbox/pillarbox object-fit:contain already adds correctly for AR
   mismatch against the viewport) and crops them out via a zoom, so a title isn't wrapped
   in two stacked sets of bars. Diagnosed against a real title (Lilo & Stitch's Plex file
   is a 720x480 NTSC transfer with the true 1.66:1 theatrical picture matted inside it,
   38px top/bottom and 18px left/right of baked-in black border) - see this repo's memory
   for how that was confirmed (drawing a frame to an offscreen canvas and scanning inward
   per edge, plus ambient lighting's own glow only reaching the outer gap and not the
   inner border, proving the extra bars are inside the source frame, not something this
   player's own rendering pipeline adds).

   Web/PC only (gated on controller._videoEl) - Xbox has no DOM <video> element to sample
   a frame from (native video renders in a separate XAML layer, see xbox-bridge.js), and a
   native crop there would need its own MediaPlayerElement-side implementation. Composes
   with the shader-upscaling canvas "for free": that canvas's own backing buffer
   (shader-pipeline.js's outputSizeFor) always preserves the raw video's own aspect ratio,
   so the same border FRACTIONS detected against the raw frame apply unchanged to the
   canvas regardless of its own pixel resolution - see applyAutoCropGeometry below, which
   sizes/positions both elements from fractions alone, never a resolution.

   The crop is a real zoom (CSS width/height/position, not a lossless operation) - same
   tradeoff as a TV's "zoom" mode, loses a little detail at the edges - not a plain
   `transform: scale()` on the existing object-fit-rendered box, because that would scale
   whatever outer letterbox Fit mode already added for viewport AR mismatch right along
   with the inner border, non-uniformly distorting the true picture. Instead this computes
   the letterbox/cover/stretch box (pictureBoxFor, one shared implementation of Fit/
   Cover/Stretch keyed off the CROPPED effective aspect ratio rather than the raw one) and
   then sizes/positions the video/canvas element so exactly the crop sub-rectangle lands on
   that box - undistorted for Fit/Cover (the box's own AR already equals the crop's true
   AR), intentionally distorted for Stretch (matching what Stretch already means without
   any crop active). A CSS `clip-path: inset()` on top of that sizing/positioning is what
   actually guarantees the border never becomes visible again on an axis that still has an
   outer Fit-mode gap of its own - see applyAutoCropGeometry's own comment for why the
   sizing alone isn't enough there. */

/* Strict on purpose - a genuinely dark SCENE (a night shot, space, a dim room) still
   almost always has some real detail/variation in it, averaging well above a low luma
   floor even at the frame's own edges; a true matted-in border is flat, uniform #000 (or
   very close to it) across its entire width, every single frame. Raising this to be more
   "forgiving" of compression noise (an earlier version of this file tried 24) backfired
   badly - it also made a merely-dark scene read as a border, cropping into real picture
   content on a false trigger. CROP_SAFETY_MARGIN_FRACTION below and the two-sample
   confirmation in scheduleDetection are what actually cover compression noise now,
   without needing this threshold to also carry that job. */
const BLACK_LUMA_THRESHOLD = 10;
/* A real matted-in border isn't just dark, it's FLAT - uniform #000 (or very close to it)
   across its entire width/height, since it's literally an unexposed edge of the film/video
   frame. A dark SCENE, even one that also clears BLACK_LUMA_THRESHOLD on average, almost
   always has some real spread to it - a faint highlight, a gradient, grain, a silhouette's
   edge - that a flat border never does. Checking the row/column's own luma RANGE (max-min)
   in addition to its average is what actually tells these apart; average alone can't, since
   a dark-but-detailed row can easily average as low as a true border does. */
const BLACK_RANGE_THRESHOLD = 24;
/* Downscaled sample size, not the real decoded frame - the detection scan is O(edge
   pixels), and this keeps that cheap (a couple hundred px per axis, not a 4K frame's
   worth) for what only ever needs to run CONFIRM_SAMPLE_COUNT times per title. */
const SAMPLE_MAX_DIM = 200;
/* Below this, treat an edge as having no real border - a compression/scaling artifact
   a pixel or two deep shouldn't trigger a crop, only a border wide enough to be a real
   matted-in transfer. */
const MIN_CROP_FRACTION = 0.01;
/* Above this on a single edge, the scan is almost certainly reading a black transition
   frame (fade-in/fade-out) or a dark scene, not a real border - caps how much a single bad
   sample can crop rather than trusting an edge-scan result unconditionally. The two-sample
   confirmation below is the main defense against a dark scene; this is the backstop for
   whatever gets past it. */
const MAX_CROP_FRACTION = 0.25;
/* Extra crop added past whatever the scan actually measured, on every edge BOTH samples
   agreed has a real border - same "overscan a little" trick a TV's own zoom mode uses,
   because no edge-detection threshold is ever going to be exactly right for every title's
   own compression noise. Applied AFTER reconcileSamples' own agreement check (a title with
   no border - or where the two samples disagree - gets no margin either, this only pads an
   already-confirmed crop), so this is what guarantees zero visible sliver of the original
   border survives on a confirmed edge. */
const CROP_SAFETY_MARGIN_FRACTION = 0.012;
/* Detection waits for real content instead of firing on the first available frame - a
   title's very first decoded frame is very often a black fade-in, which would otherwise
   get read as "border on every edge" and crop the picture for a title that has none. */
const DETECT_MIN_TIME_SEC = 0.75;
/* A single sampled frame - even with the range check above - can still get unlucky: a real
   border (present in EVERY frame of the source) needs only ONE frame to prove itself, but a
   merely dark-and-flat-enough SCENE (a fade's tail end, a near-black establishing shot) can
   occasionally pass both checks on any one sample. scheduleDetection takes CONFIRM_SAMPLE_COUNT
   samples spread CONFIRM_SAMPLE_GAP_SEC apart and only crops an edge every single one agreed on
   (see reconcileSamples) - a transient scene essentially never stays black-and-flat across the
   WHOLE spread (multiple seconds of real playback, likely spanning a cut or camera movement),
   while a real border trivially agrees every time since it's the same physical pixels each
   sample. Went from 2 samples/2s apart to 3/2s apart (a ~4s spread instead of ~2s) after still
   seeing occasional bad crops with just two - real problem hit in practice, not theoretical. */
const CONFIRM_SAMPLE_COUNT = 3;
const CONFIRM_SAMPLE_GAP_SEC = 2;

export function setAutoCropEnabled(controller, enabled) {
    controller._autoCropEnabled = enabled;
    localStorage.setItem(AUTO_CROP_STORAGE_KEY, enabled ? "1" : "0");
    if (!enabled) {
        controller._autoCropInsets = null;
        applyAutoCropGeometry(controller);
    } else {
        scheduleDetection(controller);
    }
}

/* Before this feature existed, the <video>/<canvas> elements were ALWAYS exactly
   position:fixed/inset:0/100%x100% - object-fit did the letterbox/pillarbox math
   internally and their own CSS `background` (opaque #000, or transparent while ambient
   lighting fills the gap instead - see web-fallback.js/shader-pipeline.js) was always
   guaranteed to cover the entire viewport no matter what. applyAutoCropGeometry breaks
   that guarantee on purpose - it resizes/repositions the element itself rather than
   relying on object-fit - and the resulting box is NOT always guaranteed to still reach
   every viewport edge: on the axis that already has an outer Fit-mode gap (a genuine AR
   mismatch left over after the crop), the crop's own enlargement of that axis can still
   fall short of the true viewport edge on extreme AR combinations (a very wide/narrow
   window against a title whose cropped AR is far from it). Real bug hit: with ambient
   lighting off (no full-viewport #000 fallback of its own either, see
   ambient-pipeline.js's updateAmbientPipeline), that gap had NOTHING opaque behind it at
   all, so the app underneath the player showed through. This backdrop is the fix - a
   plain, always-exactly-100%-viewport #000 div that never itself gets resized by the crop,
   sitting behind both the video/canvas (z-index 10000) and ambient lighting's own
   glow container (9990) so either can still paint over it normally, but nothing can ever
   see past it to the app below. Built unconditionally (not just once a crop is confirmed
   active) - cheap, and avoids a separate create/destroy path for the toggle-on-mid-session
   case. */
function ensureBackdrop(controller) {
    if (controller._autoCropBackdropEl) return;
    const el = document.createElement("div");
    el.className = "streaming-player-autocrop-backdrop";
    Object.assign(el.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        background: "#000",
        zIndex: "9980",
        pointerEvents: "none",
    });
    document.body.appendChild(el);
    controller._autoCropBackdropEl = el;
}

/* Called once per title from player-chrome.js's mountPlayerChrome (same gpuPipelines gate
   shader/ambient use - needs a real <video> to sample). Also where the resize listener
   gets registered, since the picture box a crop lands on depends on viewport size. */
export function updateAutoCropPipeline(controller) {
    const video = controller._videoEl;
    if (!video) return;
    ensureBackdrop(controller);
    if (!controller._autoCropResizeHandler) {
        controller._autoCropResizeHandler = () => applyAutoCropGeometry(controller);
        window.addEventListener("resize", controller._autoCropResizeHandler);
    }
    controller._autoCropInsets = null;
    if (!controller._autoCropEnabled) {
        applyAutoCropGeometry(controller);
        return;
    }
    scheduleDetection(controller);
}

/* Waits until `video` has both reached `minTime` and has a decoded frame in hand, then
   calls `callback` exactly once - shared by both the first sample and the confirmation
   sample below, since both need the identical "poll on timeupdate, fire once ready" wait. */
function waitForFrame(video, minTime, callback) {
    const attempt = () => {
        if (video.currentTime >= minTime && video.readyState >= video.HAVE_CURRENT_DATA) {
            video.removeEventListener("timeupdate", attempt);
            callback();
        }
    };
    if (video.currentTime >= minTime && video.readyState >= video.HAVE_CURRENT_DATA) {
        callback();
    } else {
        video.addEventListener("timeupdate", attempt);
    }
}

/* CONFIRM_SAMPLE_COUNT samples, CONFIRM_SAMPLE_GAP_SEC apart, reconciled by reconcileSamples -
   see that constant's own comment for why one sample (or even two) alone can't reliably tell
   a real border apart from a dark scene. */
function scheduleDetection(controller) {
    const video = controller._videoEl;
    if (!video || controller._autoCropDetectScheduled) return;
    controller._autoCropDetectScheduled = true;

    /* The video element (or the whole session) may have moved on while this was waiting -
       same superseded-async-callback guard web-fallback.js's own listeners use, needed here
       since a title switch can tear this element down before any sample's own wait elapses.
       Also covers a narrower race: the viewer flipped the toggle off again before a wait
       resolved - without it, a pending detection scheduled while it was still on would land
       afterward and silently turn the crop back on. */
    const superseded = () => controller._videoEl !== video || !controller._autoCropEnabled;

    const samples = [];
    const takeSample = () => {
        if (superseded()) {
            controller._autoCropDetectScheduled = false;
            return;
        }
        samples.push(sampleBorders(video));
        if (samples.length >= CONFIRM_SAMPLE_COUNT) {
            controller._autoCropDetectScheduled = false;
            controller._autoCropInsets = reconcileSamples(samples);
            applyAutoCropGeometry(controller);
            return;
        }
        waitForFrame(video, video.currentTime + CONFIRM_SAMPLE_GAP_SEC, takeSample);
    };
    waitForFrame(video, DETECT_MIN_TIME_SEC, takeSample);
}

/* Null on a failed sample (see sampleFrameToCanvas) - otherwise always a real object, even
   when nothing was found on any edge (all-zero), so reconcileSamples can tell "no border on
   this edge" apart from "couldn't sample this frame at all" and fail safe on the latter. */
function sampleBorders(video) {
    const imageData = sampleFrameToCanvas(video);
    return imageData ? rawDetectBorders(imageData) : null;
}

function sampleFrameToCanvas(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    try {
        ctx.drawImage(video, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    } catch (e) {
        /* Tainted-canvas SecurityError - same CORS invariant ambient-pipeline.js's
           renderAmbientFrame and shader-pipeline.js's renderShaderFrame both rely on.
           Fails closed (no crop) rather than throwing. */
        console.error("StreamingPlayer: auto-crop detection skipped - video frame is cross-origin tainted", e);
        return null;
    }
}

/* Returns both the average luma AND the range (max-min) across the row - see
   BLACK_RANGE_THRESHOLD's own comment for why a border scan needs both: average alone can't
   tell a flat black border apart from a dark-but-detailed scene that happens to average just
   as low. */
function rowLumaStats(data, w, y) {
    let sum = 0;
    let min = 255;
    let max = 0;
    for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += luma;
        if (luma < min) min = luma;
        if (luma > max) max = luma;
    }
    return { avg: sum / w, range: max - min };
}

function colLumaStats(data, w, h, x) {
    let sum = 0;
    let min = 255;
    let max = 0;
    for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += luma;
        if (luma < min) min = luma;
        if (luma > max) max = luma;
    }
    return { avg: sum / h, range: max - min };
}

function isBlack({ avg, range }) {
    return avg < BLACK_LUMA_THRESHOLD && range < BLACK_RANGE_THRESHOLD;
}

/* Scans inward from each edge until a row/column clears the "black" bar (see isBlack),
   capped at MAX_CROP_FRACTION per edge. Fractions, not pixel counts, both because the two
   axes' borders are independent (Lilo & Stitch's own 38px top/bottom vs. 18px left/right)
   and because a fraction is what applyAutoCropGeometry needs to apply the same crop to the
   shader canvas's own, differently-sized backing buffer. Raw - no margin, and "nothing
   found" comes back as zeros rather than null - see reconcileSamples, the only caller,
   for why: the raw samples need to be compared edge-by-edge before either the "no crop at
   all" or "pad the confirmed edges" decision can be made. */
function rawDetectBorders(imageData) {
    const { width: w, height: h, data } = imageData;
    const maxY = Math.max(1, Math.floor(h * MAX_CROP_FRACTION));
    const maxX = Math.max(1, Math.floor(w * MAX_CROP_FRACTION));

    let top = 0;
    while (top < maxY && isBlack(rowLumaStats(data, w, top))) top++;
    let bottom = 0;
    while (bottom < maxY && isBlack(rowLumaStats(data, w, h - 1 - bottom))) bottom++;
    let left = 0;
    while (left < maxX && isBlack(colLumaStats(data, w, h, left))) left++;
    let right = 0;
    while (right < maxX && isBlack(colLumaStats(data, w, h, w - 1 - right))) right++;

    let topFrac = top / h;
    let bottomFrac = bottom / h;
    let leftFrac = left / w;
    let rightFrac = right / w;
    if (topFrac < MIN_CROP_FRACTION) topFrac = 0;
    if (bottomFrac < MIN_CROP_FRACTION) bottomFrac = 0;
    if (leftFrac < MIN_CROP_FRACTION) leftFrac = 0;
    if (rightFrac < MIN_CROP_FRACTION) rightFrac = 0;
    return { top: topFrac, bottom: bottomFrac, left: leftFrac, right: rightFrac };
}

/* Takes the SMALLER of all CONFIRM_SAMPLE_COUNT raw samples on each edge, independently - a
   genuine baked-in border reads as roughly the same width in every sample (it's the same
   physical border, scanned repeatedly), while a dark scene that fooled one sample almost
   never survives unchanged across the WHOLE spread (the scene has moved on, or even a
   static shot's own grain/dither shifts enough that not every scan agrees) - so `min`
   naturally collapses to 0 on any edge even a single sample didn't think was a border,
   without needing a separate tolerance/agreement check. Any sample failing outright (tainted
   canvas, no video dimensions yet) fails the whole reconciliation closed - better to skip a
   real crop this title than risk one built from incomplete evidence. */
function reconcileSamples(samples) {
    if (samples.some((s) => !s)) return null;
    const top = Math.min(...samples.map((s) => s.top));
    const bottom = Math.min(...samples.map((s) => s.bottom));
    const left = Math.min(...samples.map((s) => s.left));
    const right = Math.min(...samples.map((s) => s.right));
    if (!top && !bottom && !left && !right) return null;
    /* Margin only pads an edge every sample agreed on (see CROP_SAFETY_MARGIN_FRACTION's own
       comment) - re-clamped to MAX_CROP_FRACTION so an edge that already hit that cap on
       every sample doesn't get pushed even further past it. */
    const pad = (frac) => (frac ? Math.min(MAX_CROP_FRACTION, frac + CROP_SAFETY_MARGIN_FRACTION) : 0);
    return { top: pad(top), bottom: pad(bottom), left: pad(left), right: pad(right) };
}

/* The aspect ratio ambient-pipeline.js's own computePictureRect (the letterbox/pillarbox
   gap ambient lighting fills) and applyAutoCropGeometry above both need to letterbox
   against - `rawAR` unchanged when Auto-Crop is off or found nothing this title, the
   CROPPED aspect ratio otherwise. Exported so ambient lighting's own gap sizing stays in
   sync with the actually-visible (post-crop) picture edges instead of the raw frame's -
   without this, enabling both features together would glow-panel the OLD letterbox gap
   while the real picture had already moved to fill more of the screen. */
export function cropAdjustedAspectRatio(controller, rawAR) {
    const insets = controller._autoCropEnabled ? controller._autoCropInsets : null;
    if (!insets) return rawAR;
    const visibleW = 1 - insets.left - insets.right;
    const visibleH = 1 - insets.top - insets.bottom;
    return rawAR * (visibleW / visibleH);
}

/* Fit/Cover/Stretch's own box computation (see chrome-menu-options.js's applyFitMode),
   duplicated rather than shared, because the browser's own object-fit algorithm this
   normally mirrors can't be handed a synthetic "effective" aspect ratio - object-fit
   always measures a <video>/<canvas> against its own true intrinsic size. Keyed off
   `ar` (the CROPPED effective aspect ratio) rather than the element's raw one -
   Cover picks the larger of the two scales (the opposite branch from Fit/contain,
   deliberately overflowing one axis to crop instead of letterboxing it), Stretch
   ignores `ar` entirely and always fills the viewport exactly, same as it already does
   with no crop active. */
function pictureBoxFor(ar, fitMode, vw, vh) {
    if (fitMode === "stretch") {
        return { left: 0, top: 0, width: vw, height: vh };
    }
    const viewportAR = vw / vh;
    let w;
    let h;
    if (fitMode === "cover") {
        if (ar > viewportAR) { h = vh; w = vh * ar; } else { w = vw; h = vw / ar; }
    } else {
        if (ar > viewportAR) { w = vw; h = vw / ar; } else { h = vh; w = vh * ar; }
    }
    return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

/* Applies (or clears) the crop on both the video element and the shader canvas, if one
   exists - called after detection, on window resize, and from applyFitMode whenever the
   Aspect picker changes or the shader canvas gets (re)created (see that function's own
   comment for why it's the one call site that covers all three). A no-op on Xbox
   (controller._videoEl is null there).

   No insets: resets to the plain 100%/100%/0/0 box, restoring whichever object-fit
   keyword the current fit mode actually calls for (see the "no insets" branch's own
   comment for why that has to be reasserted here rather than just left alone). An active
   crop instead sizes/positions the element explicitly and forces objectFit:"fill" - safe
   unconditionally because the
   element's own box is deliberately built to exactly match the CROPPED sub-rectangle's
   scale (Fit/Cover) or the full viewport (Stretch), so "fill" is either a no-op (the box
   already has the right aspect ratio) or the intended distortion (Stretch), never an
   unwanted stretch of its own. */
export function applyAutoCropGeometry(controller) {
    const video = controller._videoEl;
    if (!video) return;
    const targets = [video, controller._shaderCanvas].filter(Boolean);
    /* Same enabled-gated read cropAdjustedAspectRatio uses above - _autoCropInsets is
       expected to already be null whenever _autoCropEnabled is false (every call site that
       flips the flag also clears it), but resolving it the same way here too means this
       function stays correct even if some future caller doesn't. */
    const insets = controller._autoCropEnabled ? controller._autoCropInsets : null;

    if (!insets) {
        /* objectFit has to be restored explicitly here, not just left alone - a crop that
           was active a moment ago (Auto-Crop just got turned off, or a title switch reset
           detection) forced it to "fill" below, and nothing else re-asserts the real
           Fit/Cover/Stretch value afterward the way applyFitMode does when it runs on its
           own. Without this, turning Auto-Crop off after it had actually cropped something
           left the picture permanently stretched to the 100%/100% box instead of
           letterboxing/covering correctly again. Same reasoning for clipPath - a previously
           active crop's inset() clip would otherwise keep silently cutting off the picture's
           own edges even after the crop itself cleared. */
        const cssFit = cssObjectFitFor(controller._fitMode || "fit");
        targets.forEach((el) => {
            Object.assign(el.style, { width: "100%", height: "100%", left: "0", top: "0", objectFit: cssFit, clipPath: "none" });
        });
        return;
    }

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    if (!rawW || !rawH) return;
    const { left: lf, right: rf, top: tf, bottom: bf } = insets;
    const visibleW = 1 - lf - rf;
    const visibleH = 1 - tf - bf;
    const effectiveAR = cropAdjustedAspectRatio(controller, rawW / rawH);

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const box = pictureBoxFor(effectiveAR, controller._fitMode || "fit", vw, vh);
    const elementWidth = box.width / visibleW;
    const elementHeight = box.height / visibleH;
    const elementLeft = box.left - lf * elementWidth;
    const elementTop = box.top - tf * elementHeight;

    /* Pushing the border off past the element's OWN edges (elementLeft/elementTop above)
       only reliably clears the true viewport edge on an axis where `box` already spans the
       full viewport there - on an axis that ALSO has a real outer Fit-mode gap (box.top or
       box.left > 0, a genuine AR mismatch left over after the crop), the enlarged element's
       own edge can land INSIDE that gap instead of past it, since the enlargement's size
       depends only on the crop fraction, not on how big the outer gap happens to be. Real
       bug hit: on exactly that axis, part of the original border stayed visible, stretched,
       sitting opaquely on top of ambient lighting's glow in what was supposed to be a clean
       gap - reported as "ambient is rendering behind the player." clip-path fixes this
       unconditionally rather than depending on the enlargement happening to be big enough:
       it hides everything on the element outside the region that maps to `box`, regardless
       of whether that region is on-screen or off- - so the visible remainder is always
       exactly `box`, never a sliver of stretched border. Insets are in the element's OWN
       border-box coordinates (a plain fraction of elementWidth/elementHeight - lf*elementWidth
       is exactly how many px of the enlarged element the left border fraction now occupies),
       not viewport coordinates, so this needs no separate math from what's already computed
       above. */
    const clipTop = tf * elementHeight;
    const clipRight = rf * elementWidth;
    const clipBottom = bf * elementHeight;
    const clipLeft = lf * elementWidth;

    targets.forEach((el) => {
        Object.assign(el.style, {
            width: `${elementWidth}px`,
            height: `${elementHeight}px`,
            left: `${elementLeft}px`,
            top: `${elementTop}px`,
            objectFit: "fill",
            clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`,
        });
    });
}

/* Called from web-fallback.js's teardownWeb alongside the other per-session GPU/DOM
   pipelines - the resize listener lives on `window`, outside the <video>/<canvas> this
   session owns, so it needs its own explicit cleanup rather than going away with them. */
export function teardownAutoCrop(controller) {
    if (controller._autoCropBackdropEl) {
        controller._autoCropBackdropEl.remove();
        controller._autoCropBackdropEl = null;
    }
    if (controller._autoCropResizeHandler) {
        window.removeEventListener("resize", controller._autoCropResizeHandler);
        controller._autoCropResizeHandler = null;
    }
    controller._autoCropDetectScheduled = false;
    controller._autoCropInsets = null;
}
