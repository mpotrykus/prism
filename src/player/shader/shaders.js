/* Web port of the Android shader-upscaling feature (ShaderType/ShaderTuning/
   ShaderUpscaleShaderProgram in android/.../PlayerActivity's Java sources) - same two
   GLSL algorithms and the same min/max tuning endpoints a 0-100% strength slider
   interpolates between, just running as a WebGL pass over the <video> element instead
   of inside ExoPlayer's native pipeline. See plex-player.js's _ensureShaderPipeline for
   how frames get from <video> to this shader. */
export const SHADER_TYPES = {
  anime4k: {
    label: "Anime4K",
    useCas: false,
    min: { scale: 1.8, sharpen: 1.8, kernel: 1.5, saturation: 1.1, contrast: 1.05 },
    max: { scale: 2.4, sharpen: 3.8, kernel: 2.8, saturation: 1.35, contrast: 1.18 },
  },
  live_action: {
    label: "Live-Action (CAS)",
    useCas: true,
    /* saturation/contrast are a small compensating boost, not the anime shader's
       exaggeration - CAS's per-channel anti-ringing clamp (see SHADER_FRAGMENT_CAS)
       pulls sharpened pixels back toward the local neighborhood's own min/max, which
       has the side effect of slightly flattening contrast/saturation along with the
       ringing it's actually guarding against. This nudges both back up rather than
       leaving the picture looking duller than the source. */
    min: { scale: 1.3, sharpen: 1.0, kernel: 1.2, saturation: 1, contrast: 1 },
    max: { scale: 1.6, sharpen: 2.2, kernel: 1.8, saturation: 1.12, contrast: 1.06 },
    /* CAS ramps to its max tuning by 15% strength instead of 100% - the old full
       0-100% range made the slider's first ~2/3 barely perceptible (see the weight-gate
       fix above), so the previous "100%" tuning now arrives at "Light" instead of only
       at "Strong". Strength above 0.15 just stays at max, same as reaching 100% used to. */
    rampToMaxAt: 0.15,
  },
};

export function shaderTuningAt(shaderKey, strength) {
  const type = SHADER_TYPES[shaderKey];
  const rampToMaxAt = type.rampToMaxAt ?? 1;
  const t = Math.max(0, Math.min(1, strength / rampToMaxAt));
  const lerp = (a, b) => a + (b - a) * t;
  return {
    scale: lerp(type.min.scale, type.max.scale),
    sharpen: lerp(type.min.sharpen, type.max.sharpen),
    kernel: lerp(type.min.kernel, type.max.kernel),
    saturation: lerp(type.min.saturation, type.max.saturation),
    contrast: lerp(type.min.contrast, type.max.contrast),
  };
}

/* Settings' global "Upscaling" strength preset (settings.js's upscale_strength field) -
   whether the shader runs at all is now the separate upscale_enabled flag (see
   settings.js/plex-player.js's play()), so this only ever maps to this session's initial
   strength slider position. Medium (0.65) is the pre-existing default the slider used
   to always start at. */
export const UPSCALE_STRENGTH_PRESETS = { light: 0.15, medium: 0.65, strong: 0.9 };

/* Picks which of the two SHADER_TYPES algorithms suits a title, from its Plex genre
   tags - Anime4K's edge-gated line-art shader for anything animated (matches "Animation"
   and "Anime" alike, Western or Japanese), CAS everywhere else. Both platforms (this
   file and Android's PlayerActivity) get this same result computed once here rather
   than duplicating the genre check in Java - see plex-player.js's _playNative. */
export function detectShaderType(genres) {
  const isAnimated = (genres || []).some((g) => (g || "").toLowerCase().includes("anim"));
  return isAnimated ? "anime4k" : "live_action";
}

export const SHADER_VERTEX_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vUv = aPosition * 0.5 + 0.5;
}
`;

/* Anime4K/RAVU-lite-inspired variant - Sobel-edge-gated unsharp mask, so only real
   line-art contours pick up the crispness boost. Ports ShaderUpscaleShaderProgram's
   FRAGMENT_SHADER_ANIME almost verbatim - see that Java file for why this makes a hard
   edge/no-edge decision rather than CAS's contrast-range weighting below. */
export const SHADER_FRAGMENT_ANIME = `
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
  outColor = clamp(outColor, 0.0, 1.0);
  outColor = (outColor - 0.5) * uContrastBoost + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, uSaturationBoost);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;

/* Contrast Adaptive Sharpening-inspired variant, better suited to live-action footage -
   sharpen weight comes from local contrast range rather than a binary edge decision, and
   the result is clamped to the neighborhood's own min/max as an anti-ringing guard. Ports
   ShaderUpscaleShaderProgram's FRAGMENT_SHADER_CAS. */
export const SHADER_FRAGMENT_CAS = `
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
  /* Applied after the anti-ringing clamp above, not folded into it - this is compensating
     for that clamp's own flattening side effect (see SHADER_TYPES.live_action's comment),
     so it needs to run on the already-clamped result rather than change what gets clamped. */
  outColor = (outColor - 0.5) * uContrastBoost + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, uSaturationBoost);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;
