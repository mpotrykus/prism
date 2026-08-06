package com.mpotrykus.streaming;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.view.View;

/* Backs "Auto strength" for Shader Upscaling/Color Boost (see PlayerActivity's
   upscaleAuto/colorBoostAuto and shaders.js's autoUpscaleStrength/autoColorBoostStrength
   on the web leg, which this mirrors). Shares FrameBitmapCapture's capture mechanics with
   AmbientLightSampler but computes whole-frame stats instead of edge zones - strength has
   nothing to do with position, unlike ambient light's per-edge glow.

   Throttled far coarser than AmbientLightSampler's own 42ms - unlike ambient light, which
   should track the picture closely, a strength value visibly "pumping" every couple
   frames would read as a bug, not a feature. */
final class ContentAnalysisSampler {
    private static final long SAMPLE_INTERVAL_MS = 750L;
    private static final int SAMPLE_W = 32;
    private static final int SAMPLE_H = 18;
    /* Slower than AmbientLightSampler's own SMOOTHING_FACTOR (0.3) at that sampler's
       42ms tick - at this sampler's 750ms tick, the same 0.3 EMA already settles in ~2s,
       which is plenty responsive for a strength value that shouldn't visibly react to
       single-frame outliers (a stray bright flash, a single grainy shot) the way
       ambient's per-frame color glow is expected to. */
    private static final float SMOOTHING_FACTOR = 0.3f;

    interface StatsListener {
        void onStats(float avgSaturation, float edgeEnergy);
    }

    private final StatsListener listener;
    private final FrameBitmapCapture capture;
    private final int[] pixels = new int[SAMPLE_W * SAMPLE_H];
    private Float smoothedSaturation = null;
    private Float smoothedEdgeEnergy = null;

    ContentAnalysisSampler(View videoSurfaceView, StatsListener listener) {
        this.listener = listener;
        this.capture = new FrameBitmapCapture(videoSurfaceView, SAMPLE_W, SAMPLE_H, SAMPLE_INTERVAL_MS, this::processBitmap);
    }

    boolean isSupported() {
        return capture.isSupported();
    }

    void start() {
        capture.start();
    }

    void stop() {
        capture.stop();
    }

    private void processBitmap(Bitmap bitmap) {
        bitmap.getPixels(pixels, 0, SAMPLE_W, 0, 0, SAMPLE_W, SAMPLE_H);
        float rawSaturation = averageSaturation();
        float rawEdgeEnergy = averageEdgeEnergy();
        smoothedSaturation = smooth(smoothedSaturation, rawSaturation);
        smoothedEdgeEnergy = smooth(smoothedEdgeEnergy, rawEdgeEnergy);
        listener.onStats(smoothedSaturation, smoothedEdgeEnergy);
    }

    private static float smooth(Float prev, float raw) {
        if (prev == null) return raw;
        return prev + (raw - prev) * SMOOTHING_FACTOR;
    }

    private float averageSaturation() {
        long total = 0;
        int count = pixels.length;
        for (int pixel : pixels) {
            int r = Color.red(pixel);
            int g = Color.green(pixel);
            int b = Color.blue(pixel);
            int max = Math.max(r, Math.max(g, b));
            int min = Math.min(r, Math.min(g, b));
            total += (max - min);
        }
        return count == 0 ? 0f : (total / (float) count) / 255f;
    }

    /* Mean Sobel-style gradient magnitude across the sampled grid - same gx/gy math as
       shaders.js's autoUpscaleStrength-supporting sampler on the web leg, just over this
       tiny bitmap's packed pixels instead of a raw byte ImageData array. A high value
       means the frame already shows plenty of fine detail/edge content;
       PlayerActivity.applyVideoEffects's use of ShaderTuning only lets this damp the
       resolution-driven sharpen need (see autoUpscaleStrength's own comment on the web
       leg for why: this can't distinguish real detail from noise). */
    private float averageEdgeEnergy() {
        double total = 0;
        int count = 0;
        for (int y = 1; y < SAMPLE_H - 1; y++) {
            for (int x = 1; x < SAMPLE_W - 1; x++) {
                float lN = luma(pixels[(y - 1) * SAMPLE_W + x]);
                float lS = luma(pixels[(y + 1) * SAMPLE_W + x]);
                float lW = luma(pixels[y * SAMPLE_W + (x - 1)]);
                float lE = luma(pixels[y * SAMPLE_W + (x + 1)]);
                float gx = lE - lW;
                float gy = lS - lN;
                total += Math.sqrt(gx * gx + gy * gy) / 255.0;
                count++;
            }
        }
        if (count == 0) return 0f;
        return (float) Math.min(1.0, (total / count) * 4.0);
    }

    private static float luma(int pixel) {
        return 0.299f * Color.red(pixel) + 0.587f * Color.green(pixel) + 0.114f * Color.blue(pixel);
    }
}
