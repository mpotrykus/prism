#version 300 es
/* Auto-Crop's GL pass - see AutoCropSampler's own header comment for the detection half and
   AiUpscaleShaderProgram.renderCropPass for how this fits into the always-on SDR effects chain.
   Pure UV remap: samples SOURCE from inside the detected border rather than resizing anything on
   this shader's own terms. Mirrors auto-crop.js's own
   `u' = insetLeft + u*(1-insetLeft-insetRight)` remap exactly.

   Android-only for now (see GlAssetLoader.java's own header comment: this whole directory is
   synced verbatim into android/app/src/main/assets/shaders/ by scripts/android-sync-shaders.mjs
   before every Android build - a copy hand-placed only in that destination folder gets wiped by
   the very next sync). The web leg crops via plain CSS geometry (src/player/auto-crop.js's
   applyAutoCropGeometry), not a GL pass, so nothing there references this file - unreferenced
   by the web bundle is expected, not a dead file to clean up.

   Real-device finding (2026-08-26): this is a plain crop+resample, not a fit/cover/letterbox -
   it's undistorted ONLY because AiUpscaleShaderProgram.configure() sizes THIS PASS'S OWN
   destination target (renderCropPass/ensureCropTarget) to the true cropped effective dimensions
   (raw input scaled by cropW/cropH below), not to the raw frame's own dimensions - so source (the
   crop sub-rect) and destination always share the same aspect ratio by construction, and this
   remap is just a resample between two same-AR rectangles, never a stretch. Two earlier versions
   of this file got this wrong in opposite ways, both because the destination was still pinned to
   the RAW frame's dimensions at the time: one stretched the sub-rect per-axis to fill that
   mismatched canvas (distorted the picture on any title whose true content AR differed a lot from
   the raw frame's, e.g. Wall-E); the other fit-and-centered it instead (undistorted, but left a
   residual black gap where the crop's own AR didn't fill the raw canvas exactly). Neither problem
   applies here - see AiUpscaleShaderProgram's own header comment for why the destination's
   dimensions can actually change now (a one-time player.setVideoEffects() reinstall once Auto-Crop
   confirms a border, not a live update into an already-pinned buffer). */
precision highp float;
uniform sampler2D uTex;
uniform float uInsetLeft;
uniform float uInsetTop;
uniform float uInsetRight;
uniform float uInsetBottom;
in vec2 vUv;
out vec4 prismFragColor;

void main() {
  /* Assumes the standard OpenGL texture convention (v=0 at the bottom of the decoded frame,
     matching every other pass in this chain, none of which apply their own vertical flip) -
     top/bottom insets are named for the frame's own visual top/bottom, so uInsetTop maps
     against (1-v) here. NOT verified on a real device yet (see AutoCropSampler's own header
     comment) - if top/bottom ever come out swapped on real hardware, this is the line to flip,
     not AutoCropSampler's detection math (which only ever reasons in frame-relative top/
     bottom/left/right, never texture-space v). */
  vec2 uv;
  uv.x = uInsetLeft + vUv.x * (1.0 - uInsetLeft - uInsetRight);
  uv.y = uInsetBottom + vUv.y * (1.0 - uInsetTop - uInsetBottom);
  prismFragColor = texture(uTex, uv);
}
