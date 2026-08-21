using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Windows.Foundation;
using Windows.Media;
using Windows.Media.Effects;
using Windows.Media.MediaProperties;

namespace PrismUwpEffects
{
    /// <summary>
    /// Same "byte-pointer access to a WinRT buffer" COM interface every UWP audio/video frame
    /// sample uses to get at raw memory - a fixed, long-documented GUID
    /// (5b0d3235-4dba-4d44-865e-8f1d0e4fd04d), not something version-sensitive. IMemoryBufferReference
    /// (what AudioBuffer.CreateReference() returns) implements this privately; there is no public
    /// managed-array accessor, so QueryInterface'ing for it via this declaration is the documented
    /// way in, same as ShaderVideoEffect's sibling video-frame path goes through Win2D instead
    /// (Win2D happens to wrap this same pattern for D3D surfaces; there is no Win2D-equivalent
    /// convenience wrapper for raw PCM samples).
    /// </summary>
    [ComImport]
    [Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    unsafe interface IMemoryBufferByteAccess
    {
        void GetBuffer(out byte* buffer, out uint capacity);
    }

    /// <summary>
    /// The one native audio effect added via <c>MediaPlayer.AddAudioEffect(typeof(AudioLevelingEffect)
    /// .FullName, true, new PropertySet())</c> from <c>NativePlayerHost</c> - the audio-leg sibling of
    /// <see cref="ShaderVideoEffect"/>, same "must live in this separate Windows Runtime Component
    /// project" constraint (Microsoft's audio-effects doc has the identical "can't be included
    /// directly in your app's project" restriction as the video one ShaderVideoEffect's own header
    /// cites).
    ///
    /// Loudness normalization, not dynamics compression - the native-Windows leg of the same design
    /// as plex-player.js's src/player/audio-leveling.js and Android's AudioLevelingProcessor.java
    /// (see either's header for why this measures live rather than reading Plex loudness metadata
    /// that doesn't exist, and why the smoothing time constants below matter). All three platforms
    /// share the same target level/clamp/tau constants so they behave the same way - and are equally
    /// first-guess numbers in need of a real listening pass.
    ///
    /// UNVERIFIED ON REAL HARDWARE. Unlike ShaderVideoEffect (confirmed working via a dedicated
    /// Phase 0 spike before this codebase relied on it), this class has not been run on a real
    /// console or PC yet - IBasicAudioEffect/MediaPlayer.AddAudioEffect's API shape below was
    /// confirmed against the actual Windows.winmd metadata (ildasm), not guessed, but whether it
    /// actually attaches cleanly to this app's HLS/decision-engine playback pipeline, and whether it
    /// coexists correctly with ShaderVideoEffect's own MediaPlayer.RemoveAllEffects() calls (see
    /// NativePlayerHost.SyncEffectAttachment's own comment on why that one shared removal method is
    /// the real risk here), is still open. Test both: does toggling "Normalize Audio" (the
    /// Options-screen toggle this class backs) do anything audible at all, and does toggling
    /// Ambient Lighting/Sharpening/Color Boost off and back on (which calls RemoveAllEffects)
    /// silently kill it along with it.
    /// </summary>
    public sealed class AudioLevelingEffect : IBasicAudioEffect
    {
        private const double TargetDbfs = -20;
        private const double MaxGainDb = 15;
        private const double MinGainDb = -15;
        private const double LoudnessEmaTauSeconds = 20;
        private const double GainRampTimeConstantSeconds = 2;
        private const double SilenceFloorDbfs = -60;

        private uint _sampleRate;
        private uint _channelCount;
        private double? _emaDb;
        private float _currentGain = 1f;

        // In-place modification of InputFrame's own buffer - no separate OutputFrame to fill, same
        // "simple in-place effect" shape Microsoft's own custom-audio-effect sample uses.
        public bool UseInputFrameForOutput => true;

        // MediaFoundation's audio-effect pipeline always negotiates Float32 PCM at the
        // IBasicAudioEffect boundary regardless of the source's own encoding - advertising one
        // concrete CreatePcm/Float property here (32 bits/sample) mirrors ShaderVideoEffect's own
        // single ARGB32 entry, rather than returning an empty list and hoping the pipeline infers it.
        public IReadOnlyList<AudioEncodingProperties> SupportedEncodingProperties
        {
            get
            {
                AudioEncodingProperties props = AudioEncodingProperties.CreatePcm(48000, 2, 32);
                props.Subtype = MediaEncodingSubtypes.Float;
                return new List<AudioEncodingProperties> { props };
            }
        }

        public void SetEncodingProperties(AudioEncodingProperties encodingProperties)
        {
            _sampleRate = encodingProperties.SampleRate;
            _channelCount = Math.Max(1, encodingProperties.ChannelCount);
        }

        public void SetProperties(Windows.Foundation.Collections.IPropertySet configuration)
        {
            // Configuration flows through AudioLevelingSettings (a shared static, same process),
            // same reasoning as ShaderVideoEffect.SetProperties - this parameter only exists to
            // satisfy IMediaExtension.
        }

        public void DiscardQueuedFrames()
        {
            // A discontinuity (seek, title switch) - fresh measurement rather than carrying a
            // possibly-stale estimate across the gap, same reasoning AudioLevelingProcessor.onReset
            // documents on the Android leg.
            _emaDb = null;
            _currentGain = 1f;
        }

        public void Close(MediaEffectClosedReason reason)
        {
            // No GPU/unmanaged resources of its own to release - unlike ShaderVideoEffect, this
            // effect never allocates anything beyond its own small value-typed fields.
        }

        public unsafe void ProcessFrame(ProcessAudioFrameContext context)
        {
            if (!AudioLevelingSettings.Enabled || _sampleRate == 0)
            {
                return;
            }

            using (AudioBuffer buffer = context.InputFrame.LockBuffer(AudioBufferAccessMode.ReadWrite))
            using (IMemoryBufferReference reference = buffer.CreateReference())
            {
                var byteAccess = (IMemoryBufferByteAccess)reference;
                byte* rawBytes;
                uint capacityBytes;
                byteAccess.GetBuffer(out rawBytes, out capacityBytes);
                float* samples = (float*)rawBytes;
                int sampleCount = (int)(capacityBytes / sizeof(float));
                if (sampleCount == 0) return;

                double sumSquares = 0;
                for (int i = 0; i < sampleCount; i++)
                {
                    double s = samples[i];
                    sumSquares += s * s;
                }
                double rms = Math.Sqrt(sumSquares / sampleCount);
                double instantDb = Math.Max(SilenceFloorDbfs, rms > 0 ? 20 * Math.Log10(rms) : SilenceFloorDbfs);

                // Same "size the smoothing step off real audio duration, not a call count" reasoning
                // as AudioLevelingProcessor.queueInput - ProcessFrame's own chunk size/cadence isn't
                // a timer this class controls.
                int frameCount = sampleCount / (int)_channelCount;
                double bufferDurationSeconds = frameCount / (double)_sampleRate;
                double loudnessAlpha = Clamp01(bufferDurationSeconds / LoudnessEmaTauSeconds);
                _emaDb = _emaDb == null ? instantDb : _emaDb + loudnessAlpha * (instantDb - _emaDb.Value);

                double targetDb = Math.Max(MinGainDb, Math.Min(MaxGainDb, TargetDbfs - _emaDb.Value));
                double targetLinearGain = Math.Pow(10, targetDb / 20);
                double gainAlpha = Clamp01(bufferDurationSeconds / GainRampTimeConstantSeconds);
                _currentGain += (float)((targetLinearGain - _currentGain) * gainAlpha);

                for (int i = 0; i < sampleCount; i++)
                {
                    float scaled = samples[i] * _currentGain;
                    samples[i] = Math.Max(-1f, Math.Min(1f, scaled));
                }
            }
        }

        private static double Clamp01(double value)
        {
            return Math.Max(0, Math.Min(1, value));
        }
    }
}
