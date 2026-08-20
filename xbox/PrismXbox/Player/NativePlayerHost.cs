using System;
using System.Globalization;
using System.Threading.Tasks;
using PrismXboxEffects;
using Windows.Foundation.Collections;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.UI.Xaml.Controls;

namespace PrismXbox.Player
{
    /// <summary>
    /// The native player: a <see cref="MediaPlayer"/> presented by a <see cref="MediaPlayerElement"/>
    /// that sits behind the transparent WebView2, playing Plex's progressive output.
    ///
    /// Progressive (<c>protocol=http</c>, <c>start.mp4</c>) rather than HLS, decided by measurement
    /// on real hardware rather than preference - see
    /// docs/xbox-native-hdr-player/05-phase0-spike-results.md. Plex serves empty single-packet TS
    /// segments for a fresh HLS session regardless of token, and AdaptiveMediaSource additionally
    /// mis-seeks on Plex's <c>#EXT-X-START:TIME-OFFSET</c> by reading an absolute media position as an
    /// offset into a playlist that already begins there. Progressive plays and sustains, so this class
    /// deliberately has no AdaptiveMediaSource in it at all.
    ///
    /// Raises events for <see cref="PlayerBridge"/> to forward to JS. It owns playback only; the whole
    /// player UI lives in the WebView2, so there is nothing here for transport controls, menus or
    /// subtitles.
    /// </summary>
    internal sealed class NativePlayerHost
    {
        private readonly MediaPlayer player = new MediaPlayer();
        private readonly Action<string, string> emit;
        private readonly Action<string> log;
        private string currentUrl;
        private bool everPlayed;
        // Plex always bakes the resume point into the URL as offset= (see Play's own comment), so
        // MediaPlaybackSession.Position is 0-based from THAT point, not from the start of the title -
        // while NaturalDuration keeps reporting the title's real full length regardless of offset
        // (confirmed in the phase0 spike log: "duration 7366.2s" for a stream requested with a large
        // offset). Reporting session.Position as-is against that duration is what made the scrubber
        // always read near the beginning - this is added back on every position reported to JS.
        private long baseOffsetMs;
        private readonly HdrDisplayController hdr;
        // Tracks whether ShaderVideoEffect is currently attached to `player`, so
        // SetShaderEffect/SetColorBoost/SetAmbientLighting only call AddVideoEffect/
        // RemoveAllEffects on an actual on/off transition rather than on every settings tweak -
        // mirrors shader-pipeline.js's own "only spin the pipeline up/down at the 0%/on-off
        // boundary" reasoning.
        private bool effectAttached;
        private readonly AiUpscaleFrameServer aiUpscale;
        // Read at the start of Play/SwitchTitle only (see those methods' own comments) - a
        // mid-playback toggle takes effect on the next play/switch, same as isHdr re-evaluation
        // already only happening at those two call sites.
        private bool aiUpscalingEnabled;
        // Family key ("anime4k"/"live_action"), mirroring _shaderAutoType on the JS side, forwarded
        // to AiUpscaleFrameServer - both produce a real chain (AiUpscalePixelEffect).
        private string aiUpscalingPreset = "";

        public MediaPlayerElement Element { get; }

        /// <summary>
        /// The alternate presenter used instead of <see cref="Element"/> whenever AI Upscaling is
        /// active for the current (non-HDR) title - see <see cref="Play"/>/<see cref="SwitchTitle"/>.
        /// </summary>
        public Image AiUpscaleElement => aiUpscale.Element;

        /// <param name="emit">(eventName, jsonParams) - forwarded to JS by PlayerBridge.</param>
        public NativePlayerHost(Action<string, string> emit, Action<string> log)
        {
            this.emit = emit;
            this.log = log ?? (_ => { });
            hdr = new HdrDisplayController(this.log);

            Element = new MediaPlayerElement
            {
                // Keeps the WebView2 the only focusable control in the tree. Measured on hardware:
                // gamepad input never reaches CoreWindow.KeyDown at all - the WebView2 receives it
                // directly - so XAML has no opportunity to steal focus. IsTabStop=false is what keeps
                // that true if a future control is ever added.
                IsTabStop = false,
                // The WebView2 is on top and owns all input; the video surface must never intercept a
                // pointer event the page expects.
                IsHitTestVisible = false,
                // The page draws the entire player UI.
                AreTransportControlsEnabled = false,
                Stretch = Windows.UI.Xaml.Media.Stretch.Uniform,
            };
            Element.SetMediaPlayer(player);
            aiUpscale = new AiUpscaleFrameServer(player, this.emit, this.log);

            MediaPlaybackSession session = player.PlaybackSession;
            session.PositionChanged += (s, e) => EmitProgress(s);
            session.PlaybackStateChanged += (s, e) => OnPlaybackStateChanged(s);
            session.NaturalDurationChanged += (s, e) => EmitProgress(s);
            session.SeekCompleted += (s, e) =>
                emit("seeked", $"{{\"positionMs\":{(long)s.Position.TotalMilliseconds + baseOffsetMs}}}");

            player.MediaOpened += (s, e) => OnMediaOpened(s);
            player.MediaEnded += (s, e) => emit("ended", "{}");
            player.MediaFailed += (s, e) =>
            {
                log($"MediaFailed: {e.Error} / 0x{e.ExtendedErrorCode?.HResult:X8}");
                emit("error", $"{{\"message\":{JsonString($"{e.Error}: {e.ErrorMessage}")}}}");
            };

            // Raised on ShaderVideoEffect.ProcessFrame's own thread (a Media Foundation work
            // thread, not the UI thread) - same "must marshal before touching WebView2" rule the
            // constructor's `emit` parameter itself is already built to satisfy (see MainPage.xaml.cs's
            // Dispatcher.RunAsync wrapper around it), so simply forwarding through `emit` here is
            // enough; this class does not need its own dispatcher call.
            EffectSettings.ContentAnalysis += (avgSaturation, edgeEnergy, lumaStdDev) =>
            {
                // Real bug found and fixed 2026-08-20: this used to interpolate each value
                // inline (`{lumaStdDev:R}`) directly inside the JSON template. The hole for
                // the LAST value sat immediately against the JSON literal's own escaped
                // closing braces (`...:R}}}"`), and this specific .NET Native (UWP AOT)
                // toolchain mis-lowers a composite-format hole in that exact position - the
                // format specifier itself ("R") leaked into the output as a literal,
                // unquoted token instead of being applied, producing invalid JSON
                // (`"lumaStdDev":R}`) that PostWebMessageAsJson rejected with E_INVALIDARG
                // (0x80070057) on every single attempt. avgSaturation/edgeEnergy's holes
                // were each followed by a comma, not `}}`, so they formatted fine - only the
                // last field ever broke. Confirmed via a temporary diagnostic that logged the
                // exact assembled string (now removed): the numbers themselves were always
                // finite (never NaN/Infinity, ruling out ContentAnalysisSampler's math) and
                // always period-decimal (ruling out locale). JsonNumberArray/ambientColors
                // never hit this because it formats via a plain `.ToString("R")` method call,
                // never inline interpolation - same fix applied here: format to a string
                // first, then interpolate a bare variable with no `:format` in the hole at all.
                string avgSaturationStr = avgSaturation.ToString("R", CultureInfo.InvariantCulture);
                string edgeEnergyStr = edgeEnergy.ToString("R", CultureInfo.InvariantCulture);
                string lumaStdDevStr = lumaStdDev.ToString("R", CultureInfo.InvariantCulture);
                emit("contentAnalysis", $"{{\"avgSaturation\":{avgSaturationStr},\"edgeEnergy\":{edgeEnergyStr},\"lumaStdDev\":{lumaStdDevStr}}}");
            };
            EffectSettings.AmbientColors += (top, bottom, left, right) =>
                emit("ambientColors",
                    $"{{\"top\":{JsonNumberArray(top)},\"bottom\":{JsonNumberArray(bottom)}," +
                    $"\"left\":{JsonNumberArray(left)},\"right\":{JsonNumberArray(right)}}}");
            // Also raised off ProcessFrame's own thread - `log` already marshals to the UI thread
            // itself (it's the same delegate MainPage.xaml.cs wires up for everything else), so no
            // extra dispatcher call is needed here either.
            EffectSettings.EffectLog += (message) => log($"[effect] {message}");
        }

        /// <summary>
        /// Adds/removes ShaderVideoEffect at the actual on/off boundary (see
        /// EffectSettings.ShouldAttach) and always writes the new settings through first, so a
        /// freshly-attached effect's very first frame already sees the right values instead of a
        /// stale/default snapshot.
        /// </summary>
        public void SetShaderEffect(bool enabled, string shaderType, double strength, bool auto)
        {
            EffectSettings.SetShaderEffect(enabled, shaderType, strength, auto);
            SyncEffectAttachment();
        }

        public void SetColorBoost(
            bool saturationEnabled, bool contrastEnabled,
            double saturationStrength, double contrastStrength,
            bool saturationAuto, bool contrastAuto)
        {
            EffectSettings.SetColorBoost(saturationEnabled, contrastEnabled, saturationStrength, contrastStrength, saturationAuto, contrastAuto);
            SyncEffectAttachment();
        }

        public void SetAmbientLighting(bool enabled)
        {
            EffectSettings.SetAmbientLighting(enabled);
            SyncEffectAttachment();
        }

        /// <summary>
        /// Stage 1: enable/disable only, no preset selection yet (Stage 2 adds the real FSR1/
        /// Anime4K shader chain; Stage 3 threads a preset string through from the bridge). Takes
        /// effect at the next <see cref="Play"/>/<see cref="SwitchTitle"/>, not mid-playback -
        /// same as <c>isHdr</c>'s own re-evaluation only happening at those two call sites.
        /// </summary>
        public void SetAiUpscaling(bool enabled, string preset)
        {
            aiUpscalingEnabled = enabled;
            aiUpscalingPreset = preset ?? "";
            aiUpscale.SetFamily(aiUpscalingPreset);
        }

        private void SyncEffectAttachment()
        {
            // Deliberately NOT gated on hdr.IsHdrActive here - ShouldAttach also covers Ambient
            // Lighting's own frame sampling (see its own doc comment), which has nothing to do
            // with the SDR-tuned Sharpening/Color Boost shader and should keep working on HDR
            // titles too. The HDR skip belongs at the actual draw, inside ShaderVideoEffect
            // itself (see EffectSettings.IsHdrActive / ShaderVideoEffect.ProcessFrame) - the same
            // "sampling keeps running, only the draw is skipped" split already used for the AI
            // Upscaling frame-server case.
            bool shouldAttach = EffectSettings.ShouldAttach;
            if (shouldAttach == effectAttached) return;
            if (shouldAttach)
            {
                // effectOptional:true - if activation genuinely fails on this device (see
                // ShaderVideoEffect's own header comment for the two things this project has not
                // yet verified on real hardware), playback should keep working without effects
                // rather than refuse to play at all.
                player.AddVideoEffect(typeof(ShaderVideoEffect).FullName, true, new PropertySet());
            }
            else
            {
                player.RemoveAllEffects();
            }
            effectAttached = shouldAttach;
        }

        private static string JsonNumberArray(double[] values)
        {
            var parts = new string[values.Length];
            for (int i = 0; i < values.Length; i++) parts[i] = values[i].ToString("R");
            return "[" + string.Join(",", parts) + "]";
        }

        /// <param name="isHdr">
        /// Decided in JS from Plex's own stream metadata (colorTrc/colorSpace), which is known before
        /// playback starts - the display must be switched before the first frame, so waiting for the
        /// decoder to report its own format would be too late. Native re-reports what it actually got
        /// in loadedMetadata.
        /// </param>
        public async void Play(string url, long startPositionMs, bool isHdr)
        {
            everPlayed = false;
            currentUrl = url;
            baseOffsetMs = startPositionMs;
            // Before Source is set, so the output mode is already correct when the first frame arrives -
            // switching afterwards makes the TV resync mid-playback.
            if (isHdr) await hdr.EnableAsync();
            else await hdr.RestoreAsync();
            SetAiUpscalePathActive(isHdr);
            // hdr.IsHdrActive (the real, re-read state - not the raw isHdr request, in case
            // EnableAsync silently didn't take) just changed above - hand it to ShaderVideoEffect
            // via EffectSettings so its next ProcessFrame skips the SDR-tuned Sharpening/Color
            // Boost draw on this title if it's HDR, without affecting Ambient's own sampling.
            EffectSettings.SetHdrActive(hdr.IsHdrActive);
            // Plex encodes the start position in the URL itself (offset=), so there is no seek to
            // perform here - the stream begins where it should. startPositionMs is still recorded above
            // (see baseOffsetMs) since session.Position reports 0-based from this point, not from the
            // start of the title.
            log($"play @{startPositionMs}ms");
            player.Source = MediaSource.CreateFromUri(new Uri(url));
            player.Play();
        }

        /// <summary>
        /// Frame-server mode cannot render HDR (see AiUpscaleFrameServer's own header comment),
        /// so AI Upscaling is only ever active for a non-HDR title - decided once here, before
        /// Source is set, same as the HDR display-mode switch above. Toggling
        /// IsVideoFrameServerEnabled after Source is already playing is not attempted here; a
        /// mid-playback AI Upscaling toggle takes effect on the next play/switch instead.
        /// </summary>
        private void SetAiUpscalePathActive(bool isHdr)
        {
            bool useAiUpscale = aiUpscalingEnabled && !isHdr;
            player.IsVideoFrameServerEnabled = useAiUpscale;
            Element.Visibility = useAiUpscale
                ? Windows.UI.Xaml.Visibility.Collapsed
                : Windows.UI.Xaml.Visibility.Visible;
            aiUpscale.SetActive(useAiUpscale);
        }

        /// <summary>
        /// In-place title swap. The player instance is reused so the page's chrome never sees a
        /// teardown - the JS bridge deliberately keeps its listeners registered across this.
        /// </summary>
        public async void SwitchTitle(string url, long startPositionMs, bool isHdr)
        {
            everPlayed = false;
            currentUrl = url;
            baseOffsetMs = startPositionMs;
            // An in-place title swap can cross the SDR/HDR boundary, so the mode is re-evaluated here
            // too, not only on a cold start.
            if (isHdr) await hdr.EnableAsync();
            else await hdr.RestoreAsync();
            SetAiUpscalePathActive(isHdr);
            // hdr.IsHdrActive (the real, re-read state - not the raw isHdr request, in case
            // EnableAsync silently didn't take) just changed above - hand it to ShaderVideoEffect
            // via EffectSettings so its next ProcessFrame skips the SDR-tuned Sharpening/Color
            // Boost draw on this title if it's HDR, without affecting Ambient's own sampling.
            EffectSettings.SetHdrActive(hdr.IsHdrActive);
            log($"switchTitle @{startPositionMs}ms");
            player.Source = MediaSource.CreateFromUri(new Uri(url));
            player.Play();
        }

        public void Pause() => player.Pause();

        public void Resume() => player.Play();

        public void Seek(long positionMs)
        {
            if (player.PlaybackSession.CanSeek)
            {
                player.PlaybackSession.Position = TimeSpan.FromMilliseconds(positionMs);
                return;
            }
            // A Plex transcode session is not seekable in place: the offset is baked into the URL, so
            // seeking means asking for a new stream at a new offset. Reported so JS can rebuild the
            // URL and call play() again rather than silently doing nothing.
            log($"seek {positionMs}ms needs a reload (stream not seekable)");
            emit("seekUnsupported", $"{{\"positionMs\":{positionMs}}}");
        }

        public void SetVolume(double volume) => player.Volume = Math.Max(0, Math.Min(1, volume));

        public void SetMuted(bool muted) => player.IsMuted = muted;

        public void SetPlaybackSpeed(double speed) => player.PlaybackSession.PlaybackRate = speed;

        /// <summary>
        /// "fit"/"cover"/"stretch" from chrome-menu-extras.js's Aspect picker (see that file's
        /// applyFitMode, which sets CSS object-fit on the web leg's own &lt;video&gt; instead - there is
        /// no such element here, so the equivalent lives on the MediaPlayerElement itself). Not a
        /// switch expression: this project has no explicit LangVersion set, which defaults to a C#
        /// version that predates them.
        /// </summary>
        public void SetStretch(string mode)
        {
            Windows.UI.Xaml.Media.Stretch stretch =
                mode == "cover" ? Windows.UI.Xaml.Media.Stretch.UniformToFill
                : mode == "stretch" ? Windows.UI.Xaml.Media.Stretch.Fill
                : Windows.UI.Xaml.Media.Stretch.Uniform;
            Element.Stretch = stretch;
            aiUpscale.SetStretch(stretch);
        }

        public void Stop()
        {
            player.Pause();
            player.Source = null;
            currentUrl = null;
            emit("stopped", "{}");
            // Fire-and-forget, but it has to happen: leaving the console in HDR after playback ends makes
            // the dashboard and this app's own UI render with inaccurate colour, text especially.
            _ = hdr.RestoreAsync();
        }

        /// <summary>
        /// For app suspend and close. moonlight-xbox omits this and leaves the console stuck in HDR when
        /// killed mid-stream - a bug worth not inheriting.
        /// </summary>
        public Task RestoreDisplayAsync() => hdr.RestoreAsync();

        private void EmitProgress(MediaPlaybackSession session)
        {
            long streamPositionMs = (long)session.Position.TotalMilliseconds;
            long positionMs = streamPositionMs + baseOffsetMs;
            long durationMs = (long)session.NaturalDuration.TotalMilliseconds;
            // DownloadProgress is a 0..1 fraction of the whole stream, so buffered-ahead has to be
            // derived from it. Plex's progressive transcode does not reliably report a length, in which
            // case this reads 0 - which is why ABR on this platform is stall-driven rather than
            // bandwidth-driven (see core/abr.js's setStallDrivenAbr). Computed against the stream-relative
            // position, not the offset-adjusted one above - DownloadProgress is itself 0-based from the
            // same stream start.
            long bufferedMs = durationMs > 0
                ? (long)(session.DownloadProgress * durationMs) - streamPositionMs
                : 0;
            emit("progress",
                $"{{\"positionMs\":{positionMs},\"durationMs\":{durationMs},\"bufferedMs\":{Math.Max(0, bufferedMs)}}}");
        }

        private void OnPlaybackStateChanged(MediaPlaybackSession session)
        {
            MediaPlaybackState state = session.PlaybackState;
            log($"PlaybackState: {state}");

            bool buffering = state == MediaPlaybackState.Buffering || state == MediaPlaybackState.Opening;
            emit("buffering", $"{{\"buffering\":{(buffering ? "true" : "false")}}}");

            if (state == MediaPlaybackState.Playing) everPlayed = true;
            // Only meaningful once playback has actually started; before that Paused is just the
            // pre-roll state, not a user-visible pause.
            if (everPlayed && (state == MediaPlaybackState.Playing || state == MediaPlaybackState.Paused))
            {
                bool paused = state == MediaPlaybackState.Paused;
                emit("stateChanged", $"{{\"paused\":{(paused ? "true" : "false")}}}");
            }
        }

        private void OnMediaOpened(MediaPlayer sender)
        {
            MediaPlaybackSession session = sender.PlaybackSession;
            // The first place real decoded video properties are known. The web leg can never report
            // these - stats-overlay.js hardcodes "HDR: n/a (browser)" because a browser cannot read a
            // <video>'s colour space without WebCodecs.
            log($"MediaOpened: {session.NaturalVideoWidth}x{session.NaturalVideoHeight}");
            aiUpscale.ConfigureSize((int)session.NaturalVideoWidth, (int)session.NaturalVideoHeight);
            emit("loadedMetadata",
                $"{{\"videoWidth\":{session.NaturalVideoWidth},\"videoHeight\":{session.NaturalVideoHeight}," +
                $"\"durationMs\":{(long)session.NaturalDuration.TotalMilliseconds}," +
                // What the output is ACTUALLY doing, not what JS predicted from Plex metadata - so the
                // stats overlay can report real HDR state rather than the web leg's "n/a (browser)".
                $"\"isHdr\":{(hdr.IsHdrActive ? "true" : "false")}}}");
        }

        // Minimal JSON string escaping, enough for the error text and log-ish values that cross here.
        // Everything else emitted above is a number or a bool.
        private static string JsonString(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
                               .Replace("\r", " ").Replace("\n", " ") + "\"";
        }
    }
}
