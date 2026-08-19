#version 300 es
/* Final pass for any multi-pass preset: scales the chain's output to the canvas and applies
   Color Boost.

   Two separate reasons this pass exists rather than letting the last algorithm pass render
   straight to the canvas:

   1. Several upstream passes are only correct at their own declared output size. Anime4K's
      depth-to-space pass picks one of four sub-pixels from the parity of the output
      coordinate, so rendering it at an arbitrary canvas size scrambles that choice. Letting
      it hit its declared 2x target and then scaling here keeps the algorithm intact.
   2. Color Boost is fused into the two hand-written sharpen shaders, which the CNN presets
      don't run at all. Putting the same lift here (identical algebra, including the
      shadowProtect feather that fixed the near-black crush) is what keeps Color Boost an
      independent toggle across every preset instead of only the sharpen ones. */
precision highp float;
uniform sampler2D uTex;
uniform float uSaturationBoost;
uniform float uContrastBoost;
uniform vec2 uOutputSize;
/* Advances every frame; a static dither pattern reads as fixed-pattern noise. */
uniform float uFrameSeed;
in vec2 vUv;
out vec4 prismFragColor;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
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
  /* CNN passes carry signed activations in half-float targets, so the final image can
     legitimately arrive slightly outside 0..1 - clamp before the boost, matching what the
     sharpen shaders do to their own output before this same algebra. */
  vec3 outColor = clamp(texture(uTex, vUv).rgb, 0.0, 1.0);
  float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));
  float contrast = mix(1.0, uContrastBoost, shadowProtect);
  float saturation = mix(1.0, uSaturationBoost, shadowProtect);
  outColor = (outColor - 0.5) * contrast + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, saturation);
  prismFragColor = vec4(clamp(ditherOut(outColor, vUv, uOutputSize, uFrameSeed), 0.0, 1.0), 1.0);
}
