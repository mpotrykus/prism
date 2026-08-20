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
  vec3 c = texture2D(uTex, uv).rgb;
  vec3 n = texture2D(uTex, uv + vec2(0.0, -off.y)).rgb;
  vec3 s = texture2D(uTex, uv + vec2(0.0,  off.y)).rgb;
  vec3 w = texture2D(uTex, uv + vec2(-off.x, 0.0)).rgb;
  vec3 e = texture2D(uTex, uv + vec2( off.x, 0.0)).rgb;
  float lc = luma(c); float ln = luma(n); float ls = luma(s); float lw = luma(w); float le = luma(e);
  float minL = min(lc, min(min(ln, ls), min(lw, le)));
  float maxL = max(lc, max(max(ln, ls), max(lw, le)));
  float contrastRange = max(maxL - minL, 0.0001);
  /* *10.0 (was *4.0) - the old threshold only ever hit full weight on very high-contrast
     edges, so on already-compressed/softly-filtered streamed video almost the whole frame
     saw near-zero sharpening. This reaches full weight on much subtler mid-detail contrast,
     so the effect is actually visible instead of only kicking in at hard edges. */
  float weight = clamp(contrastRange * 10.0, 0.0, 1.0) * uSharpenStrength;
  /* *0.5 (was *0.25) - doubles how much of the Laplacian kernel gets added once weight is
     triggered, for a visibly crisper result rather than a barely-there one. */
  vec3 sharpened = c + (4.0 * c - n - s - e - w) * weight * 0.5;
  vec3 minRgb = min(c, min(min(n, s), min(w, e)));
  vec3 maxRgb = max(c, max(max(n, s), max(w, e)));
  vec3 outColor = clamp(sharpened, minRgb, maxRgb);
  /* Same shadow-protection reasoning as SHADER_FRAGMENT_ANIME above - feather the
     contrast/saturation boost down to 1.0 (no-op) as luma approaches 0, so a linear
     mid-gray-pivoted contrast stretch can't crush near-black shades into flat 0. */
  float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));
  float contrast = mix(1.0, uContrastBoost, shadowProtect);
  float saturation = mix(1.0, uSaturationBoost, shadowProtect);
  /* Saturation and Contrast are independent controls - see sharpen-anime.frag.glsl's own
     comment on this fix (2026-08-20): contrast is applied to LUMA ONLY via an additive
     delta to R/G/B (preserves every channel difference, i.e. chroma, exactly), and
     saturation lerps toward that contrast-adjusted luma - so neither control ever touches
     the other's own contribution. */
  float l0 = luma(outColor);
  float lc = (l0 - 0.5) * contrast + 0.5;
  vec3 contrastedColor = outColor + (lc - l0);
  outColor = mix(vec3(lc), contrastedColor, saturation);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
