namespace PrismUwpEffects
{
    /// <summary>
    /// Shared state between <see cref="PrismUwp.Player.NativePlayerHost"/> (UI thread, a different
    /// assembly) and <see cref="AudioLevelingEffect"/> (a Media Foundation audio-processing thread,
    /// activated in-process by <c>MediaPlayer.AddAudioEffect</c> with no handle returned to the
    /// caller). Same "no live update handle, so use a plain shared static instead" reasoning as
    /// <see cref="EffectSettings"/> - see that class's own header comment; kept as its own separate
    /// class rather than folded into EffectSettings since that one's whole documented scope is the
    /// ShaderVideoEffect channel specifically, and this has nothing to do with video frames.
    /// </summary>
    public static class AudioLevelingSettings
    {
        private static readonly object Gate = new object();
        private static bool _enabled;

        public static bool Enabled
        {
            get
            {
                lock (Gate)
                {
                    return _enabled;
                }
            }
        }

        public static void SetEnabled(bool enabled)
        {
            lock (Gate)
            {
                _enabled = enabled;
            }
        }
    }
}
