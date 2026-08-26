package com.mpotrykus.prism;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import java.util.ArrayList;
import java.util.List;

/* Java port of src/player/auto-crop.js's DETECTION half - see that file's own extensive header
   comment for the algorithm and why every constant below is set where it is; mirrored here
   verbatim rather than re-derived. Detects black bars BAKED INTO the source video frame (as
   opposed to the outer letterbox/pillarbox PlayerView's own AspectRatioFrameLayout already adds
   for AR mismatch against the screen) by downscaling a captured frame and scanning inward from
   each of the four edges.

   Unlike AmbientLightSampler/ContentAnalysisSampler (continuous, whole-session samplers sharing
   FrameBitmapCapture's periodic-capture mechanics), this is one-shot per title: it takes exactly
   CONFIRM_SAMPLE_COUNT samples, CONFIRM_SAMPLE_GAP_MS apart, then stops itself for good - matching
   the web leg's own scheduleDetection, which never re-samples once a title's crop is decided.
   Applying the *result* lives in PlayerActivity.reinstallVideoEffectsForCrop (a one-time
   player.setVideoEffects() reinstall built with these insets baked into a fresh
   AiUpscaleShaderProgram - see that method's and that class's own header comments for why a
   reinstall, not a live update, is what it takes to get an undistorted, gap-free crop) - this
   class only ever produces the reconciled Insets, never touches rendering itself.

   Detection is confirmed on real hardware against Lilo & Stitch's own 720x480 NTSC transfer (the
   same title auto-crop.js's own header comment cites): the reconciled AR came out within ~1% of
   the theoretical value computed from that title's known 38px top/bottom / 18px left/right
   matted border. Applying the result went through several failed approaches before landing on the
   current one - see AiUpscaleShaderProgram's own header comment for the full story: a
   stretch-to-fill GL remap distorted the picture and broke Stretch aspect mode on titles with a
   drastic true content AR (e.g. Wall-E); resizing the outer AspectRatioFrameLayout to compensate,
   without also resizing the GL buffer itself, made a residual-black-band bug worse instead of
   fixing the distortion (SurfaceView content ignores ancestor View transforms); a fit-and-center
   GL remap fixed the distortion but still left that residual gap, since the buffer's own pinned
   dimensions still didn't match the true cropped content. The reinstall approach fixes the root
   cause instead of working around it: the GL buffer's declared dimensions and contentFrame's own
   aspect ratio both change together, once, to the true cropped AR - eliminating the gap and the
   distortion at the same time, at the cost of a real player.setVideoEffects() call firing
   mid-playback (a documented wedge/stall risk on this codebase for unrelated reasons - see
   reinstallVideoEffectsForCrop's own header comment - not yet verified safe against that risk on
   real hardware, specifically for a transcoded, not direct-play, title).

   One real structural difference from the web leg worth flagging: the web samples the raw
   <video> element directly via canvas drawImage, entirely independent of whatever CSS
   object-fit is currently applied. This class instead samples PlayerView's own video
   SurfaceView via FrameBitmapCapture/PixelCopy, which IS already fitted by
   AspectRatioFrameLayout per the current Aspect mode - under Cover (RESIZE_MODE_ZOOM) the
   surface is zoomed/cropped from center before this ever sees it, which could hide a real
   border from detection or (less likely) crop into real picture first. Fit mode (the default,
   and the only mode with its own outer letterbox gap to begin with) does not have this problem -
   the surface is sized to exactly the video's own AR with no cropping. Not worked around here;
   flagged as a known risk pending real-device verification. */
final class AutoCropSampler {
    private static final String TAG = "AutoCropSampler";

    // Every constant below matches src/player/auto-crop.js's own constant of the same name -
    // see that file for the reasoning behind each value.
    static final float BLACK_LUMA_THRESHOLD = 10f;
    static final float BLACK_RANGE_THRESHOLD = 24f;
    static final int SAMPLE_MAX_DIM = 200;
    static final float MIN_CROP_FRACTION = 0.01f;
    static final float MAX_CROP_FRACTION = 0.25f;
    static final float CROP_SAFETY_MARGIN_FRACTION = 0.012f;
    static final long DETECT_MIN_TIME_MS = 750L;
    static final int CONFIRM_SAMPLE_COUNT = 3;
    static final long CONFIRM_SAMPLE_GAP_MS = 2000L;

    /** Current playback position - used the same way auto-crop.js's waitForFrame checks
     * video.currentTime, so the first sample waits for real content (not a black fade-in
     * frame) and each confirmation sample is genuinely CONFIRM_SAMPLE_GAP_MS of playback
     * later, not just wall-clock time (which would drift under buffering/pause). */
    interface PositionSource {
        long currentPositionMs();
    }

    /** Reconciled fractional insets (0f-MAX_CROP_FRACTION per edge) - see reconcile() below.
     * isZero() is never actually returned as an Insets instance by this class (see start()'s
     * own comment: an all-zero reconciliation reports null instead, same as auto-crop.js's
     * reconcileSamples), kept only as a convenience for callers that build one manually. */
    static final class Insets {
        final float top, bottom, left, right;
        Insets(float top, float bottom, float left, float right) {
            this.top = top;
            this.bottom = bottom;
            this.left = left;
            this.right = right;
        }
        boolean isZero() {
            return top == 0f && bottom == 0f && left == 0f && right == 0f;
        }
    }

    interface InsetsListener {
        /** Fired exactly once per start() call, with either a real (non-zero) Insets or null
         * (no border found on any edge). */
        void onInsetsDetected(Insets insets);
    }

    private final FrameBitmapCapture capture;
    private final PositionSource positionSource;
    private final InsetsListener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int sampleW;
    private final int sampleH;
    private final List<float[]> samples = new ArrayList<>();
    private boolean running = false;

    /** sampleW/sampleH should already be scaled to the video's own aspect ratio (see
     * PlayerActivity's construction site) - mirrors auto-crop.js's sampleFrameToCanvas
     * (scale = min(1, SAMPLE_MAX_DIM / max(vw, vh))) so the downscaled sample isn't distorted
     * relative to the real frame, which the fixed 32x18 grid AmbientLightSampler/
     * ContentAnalysisSampler use gets away with (they only need broad averages) but a border-
     * fraction detector cannot. */
    AutoCropSampler(View videoSurfaceView, int sampleW, int sampleH, PositionSource positionSource, InsetsListener listener) {
        this.sampleW = sampleW;
        this.sampleH = sampleH;
        this.positionSource = positionSource;
        this.listener = listener;
        /* intervalMs (CONFIRM_SAMPLE_GAP_MS) only matters here as FrameBitmapCapture's own
           retry cadence for a not-yet-ready surface (see FrameBitmapCapture.sampleOnce's
           IllegalArgumentException catch) - this class drives its own per-sample schedule via
           waitThenCapture below rather than relying on FrameBitmapCapture's normal
           self-rescheduling loop, since each sample first has to satisfy its own playback-
           position gate. */
        this.capture = new FrameBitmapCapture(videoSurfaceView, sampleW, sampleH, CONFIRM_SAMPLE_GAP_MS, this::onBitmap);
    }

    boolean isSupported() {
        return capture.isSupported();
    }

    /** Starts the one-shot CONFIRM_SAMPLE_COUNT-sample detection sequence. No-op if already
     * running or unsupported. Safe to call again after a previous run completed (a fresh title,
     * or the "Auto-Crop" toggle flipped back on) - resets all state first. */
    void start() {
        if (running || !isSupported()) return;
        running = true;
        samples.clear();
        waitThenCapture(DETECT_MIN_TIME_MS);
    }

    void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        capture.stop();
    }

    private void waitThenCapture(long minPositionMs) {
        if (!running) return;
        if (positionSource.currentPositionMs() >= minPositionMs) {
            capture.start();
        } else {
            handler.postDelayed(() -> waitThenCapture(minPositionMs), 100L);
        }
    }

    private void onBitmap(Bitmap bitmap) {
        if (!running) return;
        /* One-shot per requested sample - FrameBitmapCapture would otherwise keep
           rescheduling itself every CONFIRM_SAMPLE_GAP_MS on its own (see its own
           scheduleNext()); stopping it here (before the NEXT waitThenCapture->capture.start()
           call, which resets FrameBitmapCapture's own `running` flag) is what keeps this
           class in full control of its own per-sample timing instead of racing it. */
        capture.stop();
        samples.add(rawDetectBorders(bitmap));
        if (samples.size() >= CONFIRM_SAMPLE_COUNT) {
            running = false;
            listener.onInsetsDetected(reconcile());
            return;
        }
        waitThenCapture(positionSource.currentPositionMs() + CONFIRM_SAMPLE_GAP_MS);
    }

    /* Returns {topFrac, bottomFrac, leftFrac, rightFrac}, already floored below
       MIN_CROP_FRACTION - same order of operations as auto-crop.js's rawDetectBorders (floor
       per-sample, BEFORE reconciliation), not after. */
    private float[] rawDetectBorders(Bitmap bitmap) {
        int[] pixels = new int[sampleW * sampleH];
        bitmap.getPixels(pixels, 0, sampleW, 0, 0, sampleW, sampleH);

        int maxY = Math.max(1, (int) Math.floor(sampleH * MAX_CROP_FRACTION));
        int maxX = Math.max(1, (int) Math.floor(sampleW * MAX_CROP_FRACTION));

        int top = 0;
        while (top < maxY && isBlack(rowLumaStats(pixels, top))) top++;
        int bottom = 0;
        while (bottom < maxY && isBlack(rowLumaStats(pixels, sampleH - 1 - bottom))) bottom++;
        int left = 0;
        while (left < maxX && isBlack(colLumaStats(pixels, left))) left++;
        int right = 0;
        while (right < maxX && isBlack(colLumaStats(pixels, sampleW - 1 - right))) right++;

        float topFrac = top / (float) sampleH;
        float bottomFrac = bottom / (float) sampleH;
        float leftFrac = left / (float) sampleW;
        float rightFrac = right / (float) sampleW;
        if (topFrac < MIN_CROP_FRACTION) topFrac = 0f;
        if (bottomFrac < MIN_CROP_FRACTION) bottomFrac = 0f;
        if (leftFrac < MIN_CROP_FRACTION) leftFrac = 0f;
        if (rightFrac < MIN_CROP_FRACTION) rightFrac = 0f;
        return new float[] {topFrac, bottomFrac, leftFrac, rightFrac};
    }

    /* {avg, range} across one row/column - see BLACK_RANGE_THRESHOLD's own comment in
       auto-crop.js for why a border scan needs both: average alone can't tell a flat black
       border apart from a dark-but-detailed scene that happens to average just as low. */
    private float[] rowLumaStats(int[] pixels, int y) {
        float sum = 0f;
        float min = 255f;
        float max = 0f;
        for (int x = 0; x < sampleW; x++) {
            float l = luma(pixels[y * sampleW + x]);
            sum += l;
            if (l < min) min = l;
            if (l > max) max = l;
        }
        return new float[] {sum / sampleW, max - min};
    }

    private float[] colLumaStats(int[] pixels, int x) {
        float sum = 0f;
        float min = 255f;
        float max = 0f;
        for (int y = 0; y < sampleH; y++) {
            float l = luma(pixels[y * sampleW + x]);
            sum += l;
            if (l < min) min = l;
            if (l > max) max = l;
        }
        return new float[] {sum / sampleH, max - min};
    }

    private static float luma(int pixel) {
        return 0.299f * Color.red(pixel) + 0.587f * Color.green(pixel) + 0.114f * Color.blue(pixel);
    }

    private static boolean isBlack(float[] stats) {
        return stats[0] < BLACK_LUMA_THRESHOLD && stats[1] < BLACK_RANGE_THRESHOLD;
    }

    /* Takes the SMALLER of every sample on each edge, independently - see auto-crop.js's
       reconcileSamples for why: a genuine baked-in border reads as roughly the same width in
       every sample (the same physical border, scanned repeatedly), while a dark scene that
       fooled one sample almost never survives unchanged across the whole ~4s spread. Unlike
       the web leg, there is no "a sample failed outright" case to fail the whole reconciliation
       closed for - a failed PixelCopy/TextureView read here never reaches onBitmap at all (see
       FrameBitmapCapture's own retry-until-ready behavior), so every entry in `samples` is
       already a real, successful read. */
    private Insets reconcile() {
        float top = Float.MAX_VALUE;
        float bottom = Float.MAX_VALUE;
        float left = Float.MAX_VALUE;
        float right = Float.MAX_VALUE;
        for (float[] s : samples) {
            top = Math.min(top, s[0]);
            bottom = Math.min(bottom, s[1]);
            left = Math.min(left, s[2]);
            right = Math.min(right, s[3]);
        }
        if (top == 0f && bottom == 0f && left == 0f && right == 0f) return null;
        return new Insets(pad(top), pad(bottom), pad(left), pad(right));
    }

    private static float pad(float frac) {
        return frac > 0f ? Math.min(MAX_CROP_FRACTION, frac + CROP_SAFETY_MARGIN_FRACTION) : 0f;
    }
}
