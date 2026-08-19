#version 300 es
/* Resolves a multi-pass preset's chain to its display-fit size, ahead of Sharpening's own
   kernel pass that now always follows this one.

   Only one reason this pass exists any more: several upstream passes are only correct at
   their own declared output size. Anime4K's depth-to-space pass picks one of four sub-pixels
   from the parity of the output coordinate, so rendering it at an arbitrary canvas size
   scrambles that choice. Letting it hit its declared 2x target and then scaling here keeps the
   algorithm intact.

   Color Boost used to live here too (this preset had no other final pass to put it in), but
   Sharpening's own algorithm always runs as a trailing pass now (see shaders.js's
   buildAnime4kCnn - explicit user call: the two toggles stack rather than one superseding the
   other) and does the identical lift itself - applying it here too would double it. Dither
   stays: it is a distinct concern (masking *this* pass's own float->8bit quantization, not
   related to whatever grading happens downstream) and this is still where that boundary is. */
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOutputSize;
/* Advances every frame; a static dither pattern reads as fixed-pattern noise. */
uniform float uFrameSeed;
in vec2 vUv;
out vec4 prismFragColor;
/* Same cheap hash as deband.frag.glsl. Duplicated rather than shared because GLSL has no
   #include and the loader deliberately does not implement one - a text-substitution include
   would have to be reproduced identically in the Android and Xbox ports. */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

/* Triangular-PDF dither at +/-0.5 LSB, applied on the way out to the 8-bit intermediate this
   pass now always writes to (it is never the true final pass any more).

   Distinct from deband's grain: that masks banding already present in the source, this masks
   banding *this pipeline* would introduce. The CNN's own passes carry their intermediates in
   half-float, and a smooth gradient quantized without dither re-bands exactly where deband just
   finished repairing it. Triangular rather than uniform noise because it decorrelates the error
   from the signal, which is why it is the standard choice for a final quantization step.

   Sum of two uniform samples minus 1 gives a triangular distribution over [-1, 1]. */
vec3 ditherOut(vec3 c, vec2 uv, vec2 size, float seed) {
  float a = hash13(vec3(uv * size, seed));
  float b = hash13(vec3(uv * size, seed + 53.0));
  return c + ((a + b) - 1.0) * (0.5 / 255.0);
}

void main() {
  /* CNN passes carry signed activations in half-float targets, so this can legitimately arrive
     slightly outside 0..1 - clamp before writing out to the (non-float) intermediate below. */
  vec3 outColor = clamp(texture(uTex, vUv).rgb, 0.0, 1.0);
  prismFragColor = vec4(clamp(ditherOut(outColor, vUv, uOutputSize, uFrameSeed), 0.0, 1.0), 1.0);
}
