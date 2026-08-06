package com.mpotrykus.streaming;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.PixelCopy;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;

/* Shared PixelCopy/TextureView frame-capture loop, factored out of what used to be
   AmbientLightSampler's own capture code once ContentAnalysisSampler needed the exact
   same mechanics (PixelCopy retry-on-not-ready, TextureView's synchronous alternative,
   self-rescheduling) for a second, differently-processed periodic snapshot of the same
   video surface - real, immediate duplication between the two samplers, not speculative.

   See AmbientLightSampler's own header comment for why frames have to be read back this
   way at all rather than reached some other way: ExoPlayer's own VideoFrameProcessor
   keeps them GPU-side with no CPU readback path already wired up. Handles both possible
   surface types PlayerView.getVideoSurfaceView() can return. */
final class FrameBitmapCapture {
    private static final String TAG = "FrameBitmapCapture";

    interface FrameListener {
        void onFrame(Bitmap bitmap);
    }

    private final SurfaceView surfaceView;
    private final TextureView textureView;
    private final FrameListener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Bitmap bitmap;
    private final long intervalMs;
    private boolean running = false;
    private final Runnable sampleRunnable = this::sampleOnce;

    FrameBitmapCapture(View videoSurfaceView, int width, int height, long intervalMs, FrameListener listener) {
        this.surfaceView = videoSurfaceView instanceof SurfaceView ? (SurfaceView) videoSurfaceView : null;
        this.textureView = videoSurfaceView instanceof TextureView ? (TextureView) videoSurfaceView : null;
        this.bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        this.intervalMs = intervalMs;
        this.listener = listener;
    }

    boolean isSupported() {
        return surfaceView != null || textureView != null;
    }

    /* "(SurfaceView)"/"(TextureView)"/"" - only used for callers' own startup logging, so
       a missing surface (isSupported() == false) doesn't need its own case here. */
    String surfaceTypeLabel() {
        if (surfaceView != null) return "(SurfaceView)";
        if (textureView != null) return "(TextureView)";
        return "";
    }

    void start() {
        if (!isSupported() || running) return;
        running = true;
        mainHandler.post(sampleRunnable);
    }

    void stop() {
        running = false;
        mainHandler.removeCallbacks(sampleRunnable);
    }

    private void sampleOnce() {
        if (!running) return;
        if (textureView != null) {
            sampleTextureView();
            return;
        }
        try {
            PixelCopy.request(surfaceView, bitmap, this::onCopyFinished, mainHandler);
        } catch (IllegalArgumentException e) {
            // Surface not ready yet (e.g. before the first frame lands) - just retry next tick.
            scheduleNext();
        }
    }

    /* Synchronous, unlike PixelCopy's callback-based API - TextureView backs its content
       with an ordinary Bitmap-copyable SurfaceTexture, no round trip needed. */
    private void sampleTextureView() {
        try {
            textureView.getBitmap(bitmap);
            listener.onFrame(bitmap);
        } catch (RuntimeException e) {
            Log.w(TAG, "TextureView.getBitmap() failed - " + e.getMessage());
        }
        scheduleNext();
    }

    private void onCopyFinished(int copyResult) {
        if (copyResult == PixelCopy.SUCCESS) {
            listener.onFrame(bitmap);
        } else {
            Log.w(TAG, "PixelCopy.request failed with result code " + copyResult);
        }
        /* Next request chained only after this one finishes (success or not), rather
           than a fixed-rate postDelayed loop that could pile up requests if a device's
           PixelCopy round trip ever runs slower than intervalMs. */
        scheduleNext();
    }

    private void scheduleNext() {
        if (running) mainHandler.postDelayed(sampleRunnable, intervalMs);
    }
}
