#version 300 es
/* First pass of the luma sub-pipeline: pulls a single-channel luma plane out of the RGB
   source so luma-only upscalers can run on it.

   Why this exists: the published mpv ports of FSR 1, CAS, NVScaler and ArtCNN all
   `//!HOOK LUMA` and read only `.r`. In mpv that hook hands them the real luma plane of a
   planar YUV frame. This pipeline has no such plane - the browser already converted to RGB
   before we ever see the frame - so without this pass those shaders would process the red
   channel and leave green and blue untouched, which is not "slightly wrong" but a completely
   broken image.

   Splitting luma out, upscaling only that, and folding the result back (see
   luma-merge.frag.glsl) is also what mpv itself does for these filters: chroma carries far
   less perceptible detail, so spending an edge-directed reconstruction on it buys nothing for
   3x the cost. */
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 prismFragColor;
/* BT.709, correct for HD content, and the same vector luma-merge subtracts back out. The
   delta trick there is only exact if both passes agree on what "luma" means - any normalized
   vector works, but it has to be the SAME one. */
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
void main() {
  prismFragColor = vec4(dot(texture(uTex, vUv).rgb, LUMA_709), 0.0, 0.0, 1.0);
}
