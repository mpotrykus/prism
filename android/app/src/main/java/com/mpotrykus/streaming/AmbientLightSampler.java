package com.mpotrykus.streaming;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.Log;
import android.view.View;

/* Averages a periodically-captured tiny downscaled snapshot of PlayerView's underlying
   video surface (via FrameBitmapCapture) into per-zone RGB colors for AmbientGlowView to
   render - see docs/plezy-player-comparison.md's "Ambient lighting" deferred-feature note
   for why ShaderUpscaleEffect's GlShaderProgram pipeline (see ShaderUpscaleShaderProgram)
   can't reach this any other way: those frames stay GPU-side inside ExoPlayer's own
   VideoFrameProcessor with no CPU readback path already wired up.

   Capture mechanics (PixelCopy/TextureView duality, scheduling) live in
   FrameBitmapCapture, shared with ContentAnalysisSampler's own (differently-processed)
   use of the same captured frames - this class only owns the edge-zone averaging/
   smoothing that's specific to ambient lighting. */
final class AmbientLightSampler {
    private static final String TAG = "AmbientLightSampler";
    private static final long SAMPLE_INTERVAL_MS = 42L;
    private static final int SAMPLE_W = 32;
    private static final int SAMPLE_H = 18;
    private static final float EDGE_FRACTION = 0.25f;
    /* Zones per edge, matching ambient-pipeline.js's AMBIENT_ZONES_PER_EDGE on the web
       leg - each edge is split into this many equal slices along its own length, each
       independently averaged/colored, instead of one flat color per side. Blended
       smoothly between adjacent zones in AmbientGlowView (a gradient stop per zone
       center, composed with the perpendicular fade-to-transparent via ComposeShader)
       rather than drawn as hard-edged rects. */
    private static final int ZONES_PER_EDGE = 8;
    /* Same algebra as ambient-pipeline.js's boostColor on the web leg (itself mirroring
       shaders.js's SHADER_FRAGMENT_CAS post-sharpen contrast/saturation lift) - a flat
       average of a real frame's edge pixels reads as dull/grayish on its own, regardless
       of how vivid the scene actually looks. */
    private static final float SATURATION_BOOST = 1.6f;
    private static final float BRIGHTNESS_BOOST = 1.3f;
    /* Temporal smoothing (an exponential moving average per zone/channel, applied in
       smoothZones) - matches ambient-pipeline.js's AMBIENT_SMOOTHING_FACTOR on the web
       leg, same reasoning: damps noise (film grain, a single stray bright frame,
       compression artifacts) out of the color *data* itself, on top of (not instead of)
       AmbientGlowView's own gradient-driven visual smoothing. 1.0 would disable
       smoothing entirely; lower values damp harder at the cost of lagging further
       behind real scene changes. */
    private static final float SMOOTHING_FACTOR = 0.3f;

    interface ColorListener {
        void onColors(int[] top, int[] bottom, int[] left, int[] right);
    }

    private final ColorListener listener;
    private final FrameBitmapCapture capture;
    private final int[] pixels = new int[SAMPLE_W * SAMPLE_H];
    /* Per-zone EMA state, one [r,g,b] float triplet per zone per edge - kept across
       start()/stop() cycles within a session (see setSmoothingInitialized's own comment)
       so toggling ambient lighting off and back on doesn't restart the smoothing from
       scratch. */
    private final float[][] smoothedTop = new float[ZONES_PER_EDGE][3];
    private final float[][] smoothedBottom = new float[ZONES_PER_EDGE][3];
    private final float[][] smoothedLeft = new float[ZONES_PER_EDGE][3];
    private final float[][] smoothedRight = new float[ZONES_PER_EDGE][3];
    private boolean smoothingInitialized = false;
    private boolean loggedFirstSample = false;

    /* Logs once (not silently no-op'ing, same reasoning FrameBitmapCapture's own
       isSupported() gate follows) if PlayerView's video surface is some third View
       subtype neither FrameBitmapCapture branch handles - start()/stop() quietly no-op
       in that case, but this makes that actually debuggable rather than indistinguishable
       from "ambient lighting just doesn't do anything." */
    AmbientLightSampler(View videoSurfaceView, ColorListener listener) {
        this.listener = listener;
        this.capture = new FrameBitmapCapture(videoSurfaceView, SAMPLE_W, SAMPLE_H, SAMPLE_INTERVAL_MS, this::processBitmap);
        if (!capture.isSupported()) {
            Log.w(TAG, "PlayerView's video surface is neither a SurfaceView nor a TextureView ("
                + (videoSurfaceView == null ? "null" : videoSurfaceView.getClass().getName())
                + ") - ambient lighting has nothing to sample from");
        }
    }

    boolean isSupported() {
        return capture.isSupported();
    }

    void start() {
        Log.d(TAG, "start() called, isSupported=" + isSupported() + " " + capture.surfaceTypeLabel());
        loggedFirstSample = false;
        capture.start();
    }

    void stop() {
        capture.stop();
    }

    private void processBitmap(Bitmap bitmap) {
        bitmap.getPixels(pixels, 0, SAMPLE_W, 0, 0, SAMPLE_W, SAMPLE_H);
        int edgeRows = Math.max(1, Math.round(SAMPLE_H * EDGE_FRACTION));
        int edgeCols = Math.max(1, Math.round(SAMPLE_W * EDGE_FRACTION));
        /* All four edges' first-ever sample gets seeded (not blended) together against
           the same smoothingInitialized flag, then it flips true right after - see
           smoothZones. */
        int[] top = smoothZones(smoothedTop, sampleZones(true, true, edgeRows));
        int[] bottom = smoothZones(smoothedBottom, sampleZones(true, false, edgeRows));
        int[] left = smoothZones(smoothedLeft, sampleZones(false, true, edgeCols));
        int[] right = smoothZones(smoothedRight, sampleZones(false, false, edgeCols));
        smoothingInitialized = true;
        /* Logged once per start(), not every ~42ms tick - confirms the whole capture
           pipeline (surface read -> pixel average -> listener) is actually alive without
           spamming logcat. If this line never appears, the problem is upstream of
           AmbientGlowView entirely (capture/sampling); if it does appear but nothing is
           visible on screen, the problem is downstream (rendering/compositing). */
        if (!loggedFirstSample) {
            loggedFirstSample = true;
            Log.d(TAG, "first sample - top=" + hexList(top) + " bottom=" + hexList(bottom)
                + " left=" + hexList(left) + " right=" + hexList(right));
        }
        listener.onColors(top, bottom, left, right);
    }

    private static String hexList(int[] colors) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < colors.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(String.format("#%06X", colors[i] & 0xFFFFFF));
        }
        return sb.append(']').toString();
    }

    /* Splits one edge's own length (SAMPLE_W for the horizontal top/bottom edges,
       SAMPLE_H for the vertical left/right edges) into ZONES_PER_EDGE equal slices and
       averages each independently - same region-averaging as averageRegion, just
       repeated per zone instead of once across the whole edge. */
    private int[] sampleZones(boolean horizontalEdge, boolean atStart, int thickness) {
        int axisLen = horizontalEdge ? SAMPLE_W : SAMPLE_H;
        int[] colors = new int[ZONES_PER_EDGE];
        for (int i = 0; i < ZONES_PER_EDGE; i++) {
            int a0 = Math.round(i * (float) axisLen / ZONES_PER_EDGE);
            int a1 = Math.round((i + 1) * (float) axisLen / ZONES_PER_EDGE);
            int len = Math.max(1, a1 - a0);
            if (horizontalEdge) {
                int y0 = atStart ? 0 : SAMPLE_H - thickness;
                colors[i] = averageRegion(a0, y0, len, thickness);
            } else {
                int x0 = atStart ? 0 : SAMPLE_W - thickness;
                colors[i] = averageRegion(x0, a0, thickness, len);
            }
        }
        return colors;
    }

    /* Exponential moving average per zone/channel - see SMOOTHING_FACTOR's own comment
       for why this exists alongside (not instead of) AmbientGlowView's own gradient
       smoothing. Mutates smoothed's rows in place (the persisted EMA state lives on this
       sampler instance across ticks) and returns freshly-boosted packed colors built
       from the updated values, for immediate use as this tick's actual display color. */
    private int[] smoothZones(float[][] smoothed, int[] raw) {
        int[] result = new int[raw.length];
        for (int i = 0; i < raw.length; i++) {
            float[] s = smoothed[i];
            if (!smoothingInitialized) {
                s[0] = Color.red(raw[i]);
                s[1] = Color.green(raw[i]);
                s[2] = Color.blue(raw[i]);
            } else {
                s[0] += (Color.red(raw[i]) - s[0]) * SMOOTHING_FACTOR;
                s[1] += (Color.green(raw[i]) - s[1]) * SMOOTHING_FACTOR;
                s[2] += (Color.blue(raw[i]) - s[2]) * SMOOTHING_FACTOR;
            }
            result[i] = Color.argb(255, clamp255(s[0]), clamp255(s[1]), clamp255(s[2]));
        }
        return result;
    }

    private int averageRegion(int x0, int y0, int w, int h) {
        long r = 0;
        long g = 0;
        long b = 0;
        int count = 0;
        for (int y = y0; y < y0 + h; y++) {
            for (int x = x0; x < x0 + w; x++) {
                int pixel = pixels[y * SAMPLE_W + x];
                r += Color.red(pixel);
                g += Color.green(pixel);
                b += Color.blue(pixel);
                count++;
            }
        }
        if (count == 0) return Color.TRANSPARENT;
        return boostColor(r / (float) count, g / (float) count, b / (float) count);
    }

    /* Pushes each channel further from (SATURATION_BOOST) the sampled luma, then scales
       all three up together (BRIGHTNESS_BOOST) - same algebra as
       ambient-pipeline.js's boostColor on the web leg. */
    private static int boostColor(float r, float g, float b) {
        float luma = 0.299f * r + 0.587f * g + 0.114f * b;
        int br = clamp255((luma + (r - luma) * SATURATION_BOOST) * BRIGHTNESS_BOOST);
        int bg = clamp255((luma + (g - luma) * SATURATION_BOOST) * BRIGHTNESS_BOOST);
        int bb = clamp255((luma + (b - luma) * SATURATION_BOOST) * BRIGHTNESS_BOOST);
        return Color.argb(255, br, bg, bb);
    }

    private static int clamp255(float v) {
        return Math.max(0, Math.min(255, Math.round(v)));
    }
}
