package com.mpotrykus.streaming;

import android.os.Handler;
import android.os.Looper;

/* Android counterpart to core/abr.js on the web leg - see that file's own header comment
   for why this can't be real seamless ABR (Plex hands back one fixed-bitrate rendition
   per transcode request, not a multi-variant HLS manifest for ExoPlayer to switch between
   natively). Walks the same ladder (PlayerUiHelper.QUALITY_CAP_PRESETS) via the existing
   PlayerActivity.switchQualityCap reload mechanism - not seamless, same brief stall a
   manual switch already causes, so the thresholds below match the web leg's deliberately
   conservative tuning exactly.

   Same Handler-based self-rescheduling loop as FrameBitmapCapture (post/postDelayed +
   removeCallbacks for start/stop, each tick chaining the next rather than a fixed-rate
   loop) rather than a raw Timer/ScheduledExecutorService, matching this codebase's
   existing per-tick-sampler idiom. */
final class QualityAbrMonitor {
    private static final long TICK_INTERVAL_MS = 5000L;
    private static final long COOLDOWN_MS = 20000L;
    private static final int STABILITY_WINDOW_TICKS = 6;
    private static final int DOWNGRADE_CONFIRM_TICKS = 2;
    private static final float STEP_UP_HEADROOM_MULTIPLIER = 1.5f;
    private static final float STEP_DOWN_THRESHOLD_MULTIPLIER = 0.9f;
    /* Same "Original has no numeric cap of its own to compare bandwidth against" proxy
       as the web leg's ORIGINAL_PROXY_KBPS. */
    private static final float ORIGINAL_PROXY_KBPS = 20000f;
    /* Same EWMA shape as ContentAnalysisSampler's own SMOOTHING_FACTOR - segment-to-
       segment throughput is noisy enough on its own that acting on a single raw sample
       instead of a smoothed one would make the tick evaluation itself unstable. */
    private static final float BANDWIDTH_SMOOTHING_FACTOR = 0.5f;

    interface Listener {
        Integer currentQualityCapKbps();
        void switchQualityCap(Integer kbps);
    }

    private final Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable tickRunnable = this::tick;
    private boolean running = false;
    private Float smoothedBandwidthKbps = null;
    private long lastSwitchAt = 0L;
    private int downgradeStreak = 0;
    private int stableStreak = 0;

    QualityAbrMonitor(Listener listener) {
        this.listener = listener;
    }

    void start() {
        if (running) return;
        running = true;
        mainHandler.postDelayed(tickRunnable, TICK_INTERVAL_MS);
    }

    void stop() {
        running = false;
        mainHandler.removeCallbacks(tickRunnable);
    }

    /* Fed from PlayerActivity's AnalyticsListener.onLoadCompleted for every completed HLS
       segment fetch - the closest ExoPlayer equivalent to hls.js's own bandwidthEstimate
       (see core/abr.js on the web leg), computed the same way: bytes over load duration,
       smoothed rather than acted on raw. ExoPlayer's own DefaultBandwidthMeter isn't used
       here - it only updates from TransferListener callbacks that createPlayer()'s bare
       DefaultHttpDataSource.Factory never wires up, so it would never see a real number
       as this player is currently built. */
    void onSegmentLoadCompleted(long bytesLoaded, long loadDurationMs) {
        if (loadDurationMs <= 0) return;
        float sampleKbps = (bytesLoaded * 8f / 1000f) / (loadDurationMs / 1000f);
        smoothedBandwidthKbps = smoothedBandwidthKbps == null
            ? sampleKbps
            : smoothedBandwidthKbps + (sampleKbps - smoothedBandwidthKbps) * BANDWIDTH_SMOOTHING_FACTOR;
    }

    /* Bypasses the stability window entirely, same as core/abr.js's notifyStall - a real
       stall is bad enough to act on immediately, still gated by the same cooldown as
       every other switch so a stall firing just after our own reload isn't mistaken for
       a fresh one. Self-guards on `running` rather than trusting the call site, same
       reasoning the web leg's notifyStall checks controller._autoQualityEnabled itself. */
    void notifyStall() {
        if (!running || withinCooldown()) return;
        int currentIndex = currentRungIndex();
        if (currentIndex >= PlayerUiHelper.QUALITY_CAP_PRESETS.length - 1) return;
        switchToRung(currentIndex + 1);
    }

    /* Called from every reload path (PlayerActivity's switchQualityCap/switchMediaVersion/
       switchAudioStream/applySubtitle, and a full title switch) - a fresh transcode
       session means whatever streak/cooldown state was building against the old one no
       longer applies. */
    void notifyReload() {
        lastSwitchAt = System.currentTimeMillis();
        downgradeStreak = 0;
        stableStreak = 0;
    }

    private void tick() {
        if (!running) return;
        evaluate();
        mainHandler.postDelayed(tickRunnable, TICK_INTERVAL_MS);
    }

    private void evaluate() {
        if (withinCooldown() || smoothedBandwidthKbps == null) return;
        PlayerUiHelper.QualityCapPreset[] presets = PlayerUiHelper.QUALITY_CAP_PRESETS;
        int currentIndex = currentRungIndex();
        boolean atFloor = currentIndex >= presets.length - 1;
        boolean atCeiling = currentIndex <= 0;
        float currentKbps = rungKbps(presets[currentIndex]);

        if (smoothedBandwidthKbps < currentKbps * STEP_DOWN_THRESHOLD_MULTIPLIER) {
            downgradeStreak++;
            stableStreak = 0;
            if (!atFloor && downgradeStreak >= DOWNGRADE_CONFIRM_TICKS) {
                switchToRung(currentIndex + 1);
            }
            return;
        }
        downgradeStreak = 0;

        if (atCeiling) {
            stableStreak = 0;
            return;
        }
        float nextUpKbps = rungKbps(presets[currentIndex - 1]);
        if (smoothedBandwidthKbps >= nextUpKbps * STEP_UP_HEADROOM_MULTIPLIER) {
            stableStreak++;
            if (stableStreak >= STABILITY_WINDOW_TICKS) {
                switchToRung(currentIndex - 1);
            }
        } else {
            stableStreak = 0;
        }
    }

    private void switchToRung(int index) {
        lastSwitchAt = System.currentTimeMillis();
        downgradeStreak = 0;
        stableStreak = 0;
        listener.switchQualityCap(PlayerUiHelper.QUALITY_CAP_PRESETS[index].kbps);
    }

    private int currentRungIndex() {
        Integer current = listener.currentQualityCapKbps();
        PlayerUiHelper.QualityCapPreset[] presets = PlayerUiHelper.QUALITY_CAP_PRESETS;
        for (int i = 0; i < presets.length; i++) {
            if (java.util.Objects.equals(presets[i].kbps, current)) return i;
        }
        return 0;
    }

    private static float rungKbps(PlayerUiHelper.QualityCapPreset preset) {
        return preset.kbps != null ? preset.kbps : ORIGINAL_PROXY_KBPS;
    }

    private boolean withinCooldown() {
        return System.currentTimeMillis() - lastSwitchAt < COOLDOWN_MS;
    }
}
