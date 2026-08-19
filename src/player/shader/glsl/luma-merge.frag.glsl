#version 300 es
/* Last pass of the luma sub-pipeline: folds the reconstructed luma plane back into the RGB
   image, scales to the canvas, and applies Color Boost.

   The fold is a plain additive delta, and that is exact rather than an approximation. Adding
   the same value d to R, G and B raises luma by exactly d (the coefficients sum to 1) while
   leaving both chroma differences (R-Y and B-Y) untouched - so `rgb + (yNew - yOld)` is
   precisely "replace Y, keep Cb and Cr", with no RGB->YCbCr->RGB round trip and no matrix.

   yOld must be the luma of the *bilinearly upscaled* RGB, not of the original source, so that
   the delta represents exactly what the upscaler reconstructed beyond what the hardware
   sampler already gave us for free.

   Color Boost lives here for the same reason it lives in present.frag.glsl: it is fused into
   the two hand-written sharpen shaders, which this preset doesn't run, and it has to stay an
   independent toggle across every preset. */
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uLuma;
uniform float uSaturationBoost;
uniform float uContrastBoost;
uniform vec2 uOutputSize;
/* Advances every frame; a static dither pattern reads as fixed-pattern noise. */
uniform float uFrameSeed;
in vec2 vUv;
out vec4 prismFragColor;
/* Must match luma-extract.frag.glsl exactly - see the note there. */
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
/* Color Boost deliberately keeps the BT.601 weights the sharpen shaders and present.frag.glsl
   use, so the boost is bit-identical whichever preset is running. Correctness of the SR luma
   plane and consistency of a saturation lift are separate concerns; sharing one vector for
   both would quietly change Color Boost's behavior on this preset only. */
float boostLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
/* Same cheap hash as deband.frag.glsl. Duplicated rather than shared because GLSL has no
   #include and the loader deliberately does not implement one - a text-substitution include
   would have to be reproduced identically in the Android and Xbox ports. */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

/* Triangular-PDF dither at +/-0.5 LSB, applied on the way out to the 8-bit canvas.

   Distinct from deband's grain: that masks banding already present in the source, this masks
   banding *this pipeline* would introduce. The multi-pass presets carry their intermediates in
   half-float and then quantize once at the end, and a smooth gradient quantized without dither
   re-bands exactly where deband just finished repairing it. Triangular rather than uniform noise
   because it decorrelates the error from the signal, which is why it is the standard choice for
   a final quantization step.

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

  float shadowProtect = smoothstep(0.0, 0.22, boostLuma(outColor));
  float contrast = mix(1.0, uContrastBoost, shadowProtect);
  float saturation = mix(1.0, uSaturationBoost, shadowProtect);
  outColor = (outColor - 0.5) * contrast + 0.5;
  outColor = mix(vec3(boostLuma(outColor)), outColor, saturation);
  prismFragColor = vec4(clamp(ditherOut(outColor, vUv, uOutputSize, uFrameSeed), 0.0, 1.0), 1.0);
}
