package com.mpotrykus.prism;

import android.content.Context;
import androidx.annotation.OptIn;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

/* The only reason this subclass exists: DefaultRenderersFactory has no public API to add
   an AudioProcessor to the sink it builds, only buildAudioSink() to override wholesale.
   The override below is exactly DefaultRenderersFactory's own default implementation
   (confirmed by decompiling it against media3 1.10.1 - setEnableFloatOutput/
   setEnableAudioOutputPlaybackParameters passed through unchanged) plus the one line
   that's the actual point of this class: setAudioProcessors(). Everything else about
   renderer construction (video, text, metadata) is untouched - super() does all of that
   exactly as PlayerActivity's previous plain `new ExoPlayer.Builder(this)` did. */
@OptIn(markerClass = UnstableApi.class)
final class AudioLevelingRenderersFactory extends DefaultRenderersFactory {

    private final AudioLevelingProcessor audioLevelingProcessor;

    AudioLevelingRenderersFactory(Context context, AudioLevelingProcessor audioLevelingProcessor) {
        super(context);
        this.audioLevelingProcessor = audioLevelingProcessor;
    }

    @Override
    protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
        return new DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
            .setAudioProcessors(new AudioProcessor[] {audioLevelingProcessor})
            .build();
    }
}
