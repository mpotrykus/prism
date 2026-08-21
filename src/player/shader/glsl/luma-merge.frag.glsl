#version 300 es
/* Last pass of the luma sub-pipeline: folds the reconstructed luma plane back into the RGB
   image and scales to the display-fit size, ahead of Sharpening's own kernel pass that now
   always follows this one.

   The fold is a plain additive delta, and that is exact rather than an approximation. Adding
   the same value d to R, G and B raises luma by exactly d (the coefficients sum to 1) while
   leaving both chroma differences (R-Y and B-Y) untouched - so `rgb + (yNew - yOld)` is
   precisely "replace Y, keep Cb and Cr", with no RGB->YCbCr->RGB round trip and no matrix.

   yOld must be the luma of the *bilinearly upscaled* RGB, not of the original source, so that
   the delta represents exactly what the upscaler reconstructed beyond what the hardware
   sampler already gave us for free.

   Color Boost used to live here too (same reason as present.frag.glsl), but Sharpening's own
   algorithm always runs as a trailing pass now (see shaders.js's buildFsr - explicit user
   call: the two toggles stack rather than one superseding the other) and does the identical
   lift itself - applying it here too would double it. Dither stays: it masks this pass's own
   float->8bit quantization, a distinct concern from whatever grading happens downstream. */
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uLuma;
uniform vec2 uOutputSize;
/* Advances every frame; a static dither pattern reads as fixed-pattern noise. */
uniform float uFrameSeed;
in vec2 vUv;
out vec4 prismFragColor;
/* Must match luma-extract.frag.glsl exactly - see the note there. */
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
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
   banding *this pipeline* would introduce. Triangular rather than uniform noise because it
   decorrelates the error from the signal, which is why it is the standard choice for a final
   quantization step.

   Sum of two uniform samples minus 1 gives a triangular distribution over [-1, 1]. */
vec3 ditherOut(vec3 c, vec2 uv, vec2 size, float seed) {
  float a = hash13(vec3(uv * size, seed));
  float b = hash13(vec3(uv * size, seed + 53.0));
  return c + ((a + b) - 1.0) * (0.5 / 255.0);
}

void main() {
  vec3 rgb = texture(uSource, vUv).rgb;
  float yOld = dot(rgb, LUMA_709);
  float yNew = texture(uLuma, vUv).r;
  vec3 outColor = clamp(rgb + (yNew - yOld), 0.0, 1.0);
  prismFragColor = vec4(clamp(ditherOut(outColor, vUv, uOutputSize, uFrameSeed), 0.0, 1.0), 1.0);
}
