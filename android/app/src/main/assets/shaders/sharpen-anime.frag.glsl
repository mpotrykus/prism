precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uKernelScale;
uniform float uSharpenStrength;
uniform float uSaturationBoost;
uniform float uContrastBoost;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 uv = vUv;
  vec2 off = uTexelSize * uKernelScale;
  vec3 center = texture2D(uTex, uv).rgb;
  vec3 n  = texture2D(uTex, uv + vec2(0.0, -off.y)).rgb;
  vec3 s  = texture2D(uTex, uv + vec2(0.0,  off.y)).rgb;
  vec3 w  = texture2D(uTex, uv + vec2(-off.x, 0.0)).rgb;
  vec3 e  = texture2D(uTex, uv + vec2( off.x, 0.0)).rgb;
  vec3 nw = texture2D(uTex, uv + vec2(-off.x, -off.y)).rgb;
  vec3 ne = texture2D(uTex, uv + vec2( off.x, -off.y)).rgb;
  vec3 sw = texture2D(uTex, uv + vec2(-off.x,  off.y)).rgb;
  vec3 se = texture2D(uTex, uv + vec2( off.x,  off.y)).rgb;
  float lN = luma(n); float lS = luma(s); float lW = luma(w); float lE = luma(e);
  float lNW = luma(nw); float lNE = luma(ne); float lSW = luma(sw); float lSE = luma(se);
  float gx = (lNE + 2.0 * lE + lSE) - (lNW + 2.0 * lW + lSW);
  float gy = (lSW + 2.0 * lS + lSE) - (lNW + 2.0 * lN + lNE);
  float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  vec3 blurredNeighborhood = (n + s + w + e) * 0.25;
  vec3 outColor = center + (center - blurredNeighborhood) * uSharpenStrength * edge;
  /* Clamp to the local 4-neighbor min/max before the [0,1] clamp - same anti-halo
     technique as sharpen-cas.frag.glsl. Without this, the unsharp-mask term above
     overshoots past the neighborhood's actual value range right at high-contrast
     edges (exactly what anime lineart is), producing a bright/dark halo fringe
     next to every line instead of a clean sharpened edge. */
  vec3 minRgb = min(center, min(min(n, s), min(w, e)));
  vec3 maxRgb = max(center, max(max(n, s), max(w, e)));
  outColor = clamp(outColor, minRgb, maxRgb);
  outColor = clamp(outColor, 0.0, 1.0);
  /* Shadow protection - (x-0.5)*contrastBoost+0.5 is a linear stretch pivoted at
     mid-gray, and for any contrastBoost > 1 that pushes near-black values negative,
     which the final clamp(0,1) then flattens to exact 0 - different near-black shades
     collapsing into the same crushed black. Feathering both boosts down to 1.0 (no-op)
     as luma approaches 0 keeps shadow detail intact while midtones/highlights still get
     the full lift. */
  float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));
  float contrast = mix(1.0, uContrastBoost, shadowProtect);
  float saturation = mix(1.0, uSaturationBoost, shadowProtect);
  outColor = (outColor - 0.5) * contrast + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, saturation);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
