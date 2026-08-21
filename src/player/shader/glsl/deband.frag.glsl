#version 300 es
/* Debanding pass, run at source resolution ahead of any upscaler.

   This is the restoration pass that matters most for what this player actually streams. Plex
   hands back a re-encoded rendition at a bitrate cap, and the first thing that costs is smooth
   gradients: night skies, fades to black, studio backdrops all quantize into visible steps. No
   upscaler helps - there is no high-frequency detail to reconstruct, the information is simply
   gone - and sharpening actively makes it worse by adding contrast across the step edges.

   Method (an implementation of the well-known randomized-neighbourhood technique, e.g. mpv's
   deband filter - written from the published approach, NOT ported from mpv's source, which is
   GPL): for each iteration, pick a pseudo-random direction and radius, sample four points
   rotated 90 degrees apart around the pixel, and average them. Where the neighbourhood is flat
   to within a threshold, the pixel is inside a band and gets replaced by that average, which
   reconstructs the gradient the encoder quantized away. Where it is not flat, there is real
   detail and the pixel is left alone. A little grain at the end masks whatever step survives.

   Randomizing per pixel and per frame is what keeps this from looking like a filter: a fixed
   sampling pattern turns banding into a visible texture instead of removing it, which is why
   uFrameSeed is threaded in rather than sampling a static offset. */
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uTexTexelSize;
/* Advances every frame so the sample pattern and grain never sit still. */
uniform float uFrameSeed;
/* All three in 8-bit LSBs / source pixels, so the numbers mean something when read. */
uniform float uDebandThreshold;
uniform float uDebandRange;
uniform float uDebandGrain;
in vec2 vUv;
out vec4 prismFragColor;

/* Cheap hash, adequate for dithering-grade randomness and far cheaper than anything
   cryptographic. Fed the pixel coordinate plus the frame seed. */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 result = texture(uTex, vUv).rgb;
  float h = hash13(vec3(vUv * uTexSize, uFrameSeed));

  /* Two iterations: the first at a short radius catches fine banding, the second further out
     catches the wide, shallow gradients that are the worst offenders. More iterations keep
     helping slightly and cost a full set of taps each, which is not the right trade on a phone. */
  for (int i = 1; i <= 2; i++) {
    float fi = float(i);
    float dist = h * uDebandRange * fi;
    h = fract(h * 7919.0 + 0.137);
    float angle = h * 6.28318530718;
    h = fract(h * 7919.0 + 0.137);
    vec2 o = dist * vec2(cos(angle), sin(angle)) * uTexTexelSize;

    /* Four taps at 90-degree rotations of the same offset - a cheap approximation of a ring
       sample, and symmetric, so a smooth gradient averages back to its own centre value
       instead of being pulled in the offset's direction. */
    vec3 a = texture(uTex, vUv + vec2( o.x,  o.y)).rgb;
    vec3 b = texture(uTex, vUv + vec2(-o.y,  o.x)).rgb;
    vec3 c = texture(uTex, vUv + vec2(-o.x, -o.y)).rgb;
    vec3 d = texture(uTex, vUv + vec2( o.y, -o.x)).rgb;
    vec3 avg = (a + b + c + d) * 0.25;

    /* Threshold loosens with radius: a wider sample legitimately spans more gradient, so
       holding it to the same tolerance would reject every wide band.

       A graduated weight, not a step() cutoff: real encoded video carries a pixel-to-pixel
       variance from compression noise/dithering/grain that almost never sits within a couple
       LSBs of *exact* agreement with the sampled average, even inside what a viewer would call
       a flat band. A binary "flat or not" test built for a noiseless synthetic gradient
       essentially never fires on real footage. Ramping the blend weight from 1 (perfect match)
       to 0 (at the threshold) instead of coin-flipping at it means near-matches - the common
       case on real content - still get partially smoothed. */
    vec3 diff = abs(result - avg);
    vec3 weight = clamp(1.0 - diff / vec3(uDebandThreshold * fi / 255.0), 0.0, 1.0);
    result = mix(result, avg, weight);
  }

  /* Grain, not dither: this is masking residual banding in the *source*, whereas the dither in
     the final pass masks quantization this pipeline introduces on the way to an 8-bit canvas.
     Both are tiny and they are not the same thing. */
  vec3 noise = vec3(
    hash13(vec3(vUv * uTexSize, uFrameSeed + 11.0)),
    hash13(vec3(vUv * uTexSize, uFrameSeed + 23.0)),
    hash13(vec3(vUv * uTexSize, uFrameSeed + 37.0))
  ) - 0.5;
  result += noise * (uDebandGrain / 255.0);

  prismFragColor = vec4(result, 1.0);
}
