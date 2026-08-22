package com.mpotrykus.prism;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;
import java.nio.ByteBuffer;

/* Loudness normalization for native (ExoPlayer) playback - the Android leg of the same
   design as plex-player.js's src/player/audio-leveling.js (see that file's own header
   for why this measures live rather than reading Plex loudness metadata that doesn't
   exist). One slowly-adapting gain per title, steering the whole mix toward a fixed
   target level - never a fast envelope follower squashing individual loud/quiet moments,
   which is what would make this dynamics compression instead of leveling.

   Installed once per ExoPlayer instance via AudioLevelingRenderersFactory - see that
   class for why the instance itself is always installed and only its enabled flag
   toggles, rather than swapping RenderersFactory on a live player (not supported).

   PCM 16-bit only (see onConfigure) - the only encoding this app's transcode/direct-play
   paths are known to negotiate; anything else throws UnhandledAudioFormatException,
   which the audio pipeline (per AudioProcessor's own contract) treats as "this processor
   cannot run" rather than a crash. */
@OptIn(markerClass = UnstableApi.class)
final class AudioLevelingProcessor extends BaseAudioProcessor {

    /* Same first-guess constants as audio-leveling.js's web leg - kept numerically
       identical so the two platforms behave the same way, and equally in need of a real
       listening pass to retune. */
    private static final double TARGET_DBFS = -20;
    private static final double MAX_GAIN_DB = 15;
    private static final double MIN_GAIN_DB = -15;
    private static final double LOUDNESS_EMA_TAU_S = 20;
    private static final double GAIN_RAMP_TIME_CONSTANT_S = 2;
    private static final double SILENCE_FLOOR_DBFS = -60;

    /* The EMA-driven gain above tracks long-run average loudness, not peaks - a quiet-
       average scene with a loud transient still gets the full boost, which can push that
       transient past full scale with nothing to stop it but a hard clamp (audible as
       clipping/crackling). This peak envelope is a fast-attack/slow-release limiter on top
       of the leveling gain: since queueInput already sees the whole buffer before writing
       output, the peak of *this* buffer is known ahead of applying gain to it, so attack
       can be instantaneous (no lookahead buffering needed) while release decays like a
       normal limiter so the reduction doesn't snap back audibly. */
    private static final double LIMITER_CEILING_DBFS = -1.0;
    private static final double LIMITER_CEILING_LINEAR = Math.pow(10, LIMITER_CEILING_DBFS / 20);
    private static final double LIMITER_RELEASE_TIME_CONSTANT_S = 0.2;

    /* Read/written only from the audio-processing thread (queueInput/onReset) except for
       this flag, which PlayerActivity's UI-thread toggle sets directly - volatile rather
       than synchronized since it's a single boolean read once per queueInput call, no
       compound state to keep consistent across threads. */
    private volatile boolean enabled;
    private Double emaDb;
    private float currentGain = 1f;
    private double peakEnvelope = 0;

    void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat inputAudioFormat) throws UnhandledAudioFormatException {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            throw new UnhandledAudioFormatException(inputAudioFormat);
        }
        return inputAudioFormat;
    }

    /* super.isActive() (BaseAudioProcessor) is true once configured, regardless of this
       processor's own on/off state - ANDing with `enabled` is what actually lets the
       pipeline skip this processor's queueInput entirely while the toggle is off, at no
       cost beyond the flag check itself. */
    @Override
    public boolean isActive() {
        return super.isActive() && enabled;
    }

    @Override
    public void queueInput(ByteBuffer inputBuffer) {
        int sampleCount = inputBuffer.remaining() / 2;
        ByteBuffer buffer = replaceOutputBuffer(inputBuffer.remaining());
        if (sampleCount == 0) {
            buffer.flip();
            return;
        }
        int startPosition = inputBuffer.position();

        long sumSquares = 0;
        int rawPeak = 0;
        for (int i = 0; i < sampleCount; i++) {
            short sample = inputBuffer.getShort(startPosition + i * 2);
            sumSquares += (long) sample * sample;
            int abs = Math.abs(sample);
            if (abs > rawPeak) rawPeak = abs;
        }
        double rms = Math.sqrt(sumSquares / (double) sampleCount) / 32768.0;
        double instantDb = Math.max(SILENCE_FLOOR_DBFS, rms > 0 ? 20 * Math.log10(rms) : SILENCE_FLOOR_DBFS);

        /* Smoothing steps are sized off this buffer's own real playback duration, not a
           fixed tick count - queueInput's chunk size/cadence isn't a timer this class
           controls, unlike the web leg's fixed 300ms setInterval, so the tau/ramp time
           constants above only mean what they say if each step accounts for how much
           audio the buffer actually represents. */
        double bufferDurationSeconds = sampleCount / (double) (inputAudioFormat.sampleRate * inputAudioFormat.channelCount);
        double loudnessAlpha = clamp01(bufferDurationSeconds / LOUDNESS_EMA_TAU_S);
        emaDb = emaDb == null ? instantDb : emaDb + loudnessAlpha * (instantDb - emaDb);

        double targetDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_DBFS - emaDb));
        double targetLinearGain = Math.pow(10, targetDb / 20);
        double gainAlpha = clamp01(bufferDurationSeconds / GAIN_RAMP_TIME_CONSTANT_S);
        currentGain += (float) ((targetLinearGain - currentGain) * gainAlpha);

        double bufferPeakScaled = (rawPeak / 32768.0) * currentGain;
        double releaseAlpha = clamp01(bufferDurationSeconds / LIMITER_RELEASE_TIME_CONSTANT_S);
        peakEnvelope = bufferPeakScaled > peakEnvelope
                ? bufferPeakScaled
                : peakEnvelope + (bufferPeakScaled - peakEnvelope) * releaseAlpha;
        double limiterGain = peakEnvelope > LIMITER_CEILING_LINEAR ? LIMITER_CEILING_LINEAR / peakEnvelope : 1.0;
        float appliedGain = (float) (currentGain * limiterGain);

        for (int i = 0; i < sampleCount; i++) {
            short sample = inputBuffer.getShort(startPosition + i * 2);
            int scaled = Math.round(sample * appliedGain);
            short clamped = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, scaled));
            buffer.putShort(clamped);
        }
        inputBuffer.position(startPosition + sampleCount * 2);
        buffer.flip();
    }

    /* Fresh title, fresh measurement - mirrors audio-leveling.js's per-<video>-element
       reset (a new ExoPlayer/AudioLevelingProcessor pair is built per title anyway, see
       PlayerActivity.createPlayer(), so this mostly matters for a reset() the pipeline
       triggers mid-lifetime rather than a title switch). */
    @Override
    protected void onReset() {
        emaDb = null;
        currentGain = 1f;
        peakEnvelope = 0;
    }

    private static double clamp01(double value) {
        return Math.max(0, Math.min(1, value));
    }
}
