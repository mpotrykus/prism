using System;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.UI.Xaml;
using PrismUwpEffects;
using Windows.Media.Playback;
using Windows.UI.Core;
using Windows.UI.Xaml.Controls;

namespace PrismUwp.Player
{
    /// <summary>
    /// Presents <see cref="MediaPlayer"/>'s frame-server output, optionally run through
    /// <see cref="AiUpscalePixelEffect"/>'s real Anime4K CNN / FSR1 chains, through a Win2D
    /// <see cref="CanvasImageSource"/> in a plain XAML <see cref="Image"/> - the alternate
    /// presenter to <see cref="NativePlayerHost"/>'s <c>MediaPlayerElement</c>, used for every
    /// non-HDR title regardless of whether AI Upscaling is enabled (see
    /// <c>NativePlayerHost.SetAiUpscalePathActive</c>'s own comment for why - the native
    /// swapchain <c>MediaPlayerElement</c> otherwise renders SDR video with crushed
    /// contrast/shadows on real hardware). AI Upscaling only controls whether
    /// <see cref="AiUpscalePixelEffect.Render"/> actually runs a chain or falls back to plain
    /// pass-through - see <c>NativePlayerHost.SetAiUpscaling</c>. Frame-server mode cannot
    /// render HDR, which is why HDR titles never route through here at all.
    /// </summary>
    internal sealed class AiUpscaleFrameServer
    {
        private readonly Action<string, string> emit;
        private readonly Action<string> log;
        private readonly CoreDispatcher dispatcher;
        private readonly CanvasDevice canvasDevice = new CanvasDevice();
        private readonly AiUpscalePixelEffect pixelEffect;

        private CanvasRenderTarget frameTarget;
        private int frameWidth;
        private int frameHeight;
        // Family key ("anime4k"/"live_action") from NativePlayerHost.SetAiUpscaling - both
        // produce a real chain (AiUpscalePixelEffect).
        private string family = "";

        // Touched only on the UI thread (see Present) - CanvasImageSource is XAML-interop (a
        // SurfaceImageSource under the hood), unlike the plain Direct3D-backed CanvasRenderTarget
        // above, and threw RPC_E_WRONG_THREAD when constructed/drawn from the frame-server
        // callback's own Media Foundation worker thread on real hardware.
        private CanvasImageSource imageSource;
        private int presentedWidth;
        private int presentedHeight;

        // Surfaced to JS as the "aiUpscaleStatus" event (see xbox-bridge.js/stats-overlay.js) -
        // the shared stats overlay has no other way to know whether this path is actually
        // running, since Xbox never builds the web leg's _shaderChains at all.
        private bool active;
        private bool receivedFrame;
        private bool upscaledLastFrame;
        private string lastError;

        // Load stats - touched only from OnVideoFrameAvailable's own worker thread (see that
        // method's own thread-affinity comment), so no lock is needed here any more than the
        // existing fields above need one. Windowed (reset every StatsWindowMs) rather than a
        // running average since the whole point is answering "is it keeping up right now" -
        // a session-long average would hide a chain that just started struggling.
        private const double StatsWindowMs = 1000;
        private readonly Stopwatch statsWindowStopwatch = Stopwatch.StartNew();
        private int framesRenderedInWindow;
        private double renderMsSumInWindow;
        private int framesDroppedForBackpressureInWindow;
        private double lastFps;
        private double lastAvgRenderMs;
        private double lastDropRate;

        // Guards against OnVideoFrameAvailable (background MF thread) touching canvasDevice's
        // shared D2D/D3D11 context while a previous frame's Present is still running on the UI
        // thread (dispatched, not awaited) - Win2D/D2D device contexts are not safe for
        // concurrent multi-threaded use, unlike the plain D3D11-resource thread-affinity already
        // discussed above. Without this, real hardware hit an AccessViolationException inside
        // CopyFrameToVideoSurface after ~tens of seconds of otherwise-correct playback - the two
        // threads' draws collided. Dropping the occasional frame when the UI thread lags behind
        // is an accepted trade-off, same spirit as other frame/seek races already dropped elsewhere.
        private volatile bool framePending;

        public Image Element { get; }

        public AiUpscaleFrameServer(MediaPlayer player, Action<string, string> emit, Action<string> log)
        {
            this.emit = emit;
            this.log = log ?? (_ => { });
            // Captured once, since this class is only ever constructed from the UI thread (same
            // as NativePlayerHost itself) - used to marshal every CanvasImageSource touch onto
            // that same thread (see Present).
            dispatcher = Windows.UI.Xaml.Window.Current.Dispatcher;

            Element = new Image
            {
                // Same invariant documented on NativePlayerHost.Element (there enforced via
                // IsTabStop too, a Control-only property Image doesn't have - Image is never
                // keyboard-focusable in the first place, so IsHitTestVisible alone is sufficient
                // here to keep the WebView2 the only thing gamepad/pointer input can reach).
                IsHitTestVisible = false,
                Stretch = Windows.UI.Xaml.Media.Stretch.Uniform,
                Visibility = Windows.UI.Xaml.Visibility.Collapsed,
                // Same "pin the element itself to center, not just trust Stretch's internal
                // crop" reasoning as NativePlayerHost.Element - this is the presenter actually
                // on screen for every non-HDR title (see this class's own header comment), so
                // it's the one that matters most for Cover ever visibly anchoring to an edge.
                HorizontalAlignment = Windows.UI.Xaml.HorizontalAlignment.Center,
                VerticalAlignment = Windows.UI.Xaml.VerticalAlignment.Center,
            };

            pixelEffect = new AiUpscalePixelEffect(canvasDevice);

            player.VideoFrameAvailable += OnVideoFrameAvailable;
        }

        public void SetStretch(Windows.UI.Xaml.Media.Stretch stretch) => Element.Stretch = stretch;

        /// <summary>
        /// Wipes the presented frame to black. Called from <c>NativePlayerHost.Stop</c> -
        /// <see cref="imageSource"/> keeps whatever CopyFrameToVideoSurface/pixelEffect last drew
        /// into it regardless of the MediaPlayer's own Source, so without this the next title's
        /// loading screen would show the previous title's last frame until its own first decoded
        /// frame arrives. Same UI-thread dispatch as Present, for the same reason.
        /// </summary>
        public void Clear()
        {
            receivedFrame = false;
            upscaledLastFrame = false;
            _ = dispatcher.RunAsync(CoreDispatcherPriority.Normal, () =>
            {
                if (imageSource == null) return;
                using (imageSource.CreateDrawingSession(Windows.UI.Colors.Black)) { }
            });
        }

        /// <summary>Family key ("anime4k"/"live_action") - see NativePlayerHost.SetAiUpscaling.</summary>
        public void SetFamily(string family)
        {
            this.family = family ?? "";
        }

        public void SetActive(bool active)
        {
            this.active = active;
            receivedFrame = false;
            upscaledLastFrame = false;
            lastError = null;
            framePending = false;
            framesRenderedInWindow = 0;
            renderMsSumInWindow = 0;
            framesDroppedForBackpressureInWindow = 0;
            lastFps = 0;
            lastAvgRenderMs = 0;
            lastDropRate = 0;
            statsWindowStopwatch.Restart();
            Element.Visibility = active ? Windows.UI.Xaml.Visibility.Visible : Windows.UI.Xaml.Visibility.Collapsed;
            EmitStatus();
        }

        /// <summary>
        /// Called from <c>NativePlayerHost.OnMediaOpened</c> once real decoded dimensions are
        /// known. <c>VideoFrameAvailable</c> is not expected to fire before <c>MediaOpened</c>,
        /// but <see cref="OnVideoFrameAvailable"/> guards on <c>frameWidth/Height</c> regardless,
        /// so an out-of-order callback just drops that one frame rather than faulting.
        /// </summary>
        public void ConfigureSize(int videoWidth, int videoHeight)
        {
            frameWidth = videoWidth;
            frameHeight = videoHeight;
        }

        private void OnVideoFrameAvailable(MediaPlayer sender, object args)
        {
            // Raised off the UI thread (a Media Foundation work thread). CanvasRenderTarget has
            // no XAML/UI-thread affinity - a plain Direct3D-backed surface, the same kind
            // ShaderVideoEffect.cs already creates/draws from this same kind of worker thread
            // without issue - so the copy below is safe here. CanvasImageSource is not; every
            // touch of it happens inside the dispatched Present call instead.
            if (framePending)
            {
                // The pipeline is falling behind the source's own frame rate - counted
                // separately from a mid-chain error fallback (see upscaledLastFrame), since this
                // is a distinct failure mode (too slow, not broken) that the plain "pass-through"
                // status line can't otherwise tell apart from a healthy chain running at full
                // rate with margin to spare.
                framesDroppedForBackpressureInWindow++;
                MaybeFlushStatsWindow();
                return; // previous frame's Present hasn't finished on the UI thread yet - drop this one rather than race canvasDevice
            }
            framePending = true;
            try
            {
                if (frameWidth <= 0 || frameHeight <= 0)
                {
                    framePending = false;
                    return;
                }
                CanvasRenderTarget target = EnsureFrameTarget();
                sender.CopyFrameToVideoSurface(target);

                // Safe on this background thread - PixelShaderEffect/CanvasRenderTarget/
                // CanvasDrawingSession are D2D/Direct3D-backed, not XAML-interop, the same
                // "no UI-thread affinity" category ShaderVideoEffect.ProcessFrame already relies
                // on for the exact same kind of drawing from this exact kind of worker thread.
                // Only CanvasImageSource (touched in Present below) needs the dispatcher hop.
                //
                // Timed specifically around this call, not the whole method - this is the actual
                // GPU/CPU work the CNN/FSR chain does per frame (the "load" the performance
                // overlay wants to show); CopyFrameToVideoSurface and the dispatcher hop below are
                // not part of that cost.
                Stopwatch renderStopwatch = Stopwatch.StartNew();
                CanvasRenderTarget processed = pixelEffect.Render(target, family, frameWidth, frameHeight, out bool chainRan);
                renderStopwatch.Stop();
                framesRenderedInWindow++;
                renderMsSumInWindow += renderStopwatch.Elapsed.TotalMilliseconds;
                MaybeFlushStatsWindow();

                // Render now always returns a real target (native pass-through with Sharpening/
                // Color Boost already applied when no chain ran) - chainRan, not a null check,
                // is what tells the stats overlay whether a real CNN/FSR chain actually ran.
                int width = (int)processed.SizeInPixels.Width;
                int height = (int)processed.SizeInPixels.Height;
                _ = dispatcher.RunAsync(CoreDispatcherPriority.Normal, () =>
                {
                    try
                    {
                        Present(processed, width, height, chainRan);
                    }
                    finally
                    {
                        framePending = false;
                    }
                });
            }
            catch (Exception ex)
            {
                framePending = false;
                ReportError(ex);
            }
        }

        /// <summary>
        /// Windowed rather than cumulative - see the fields' own comment for why. Runs on the
        /// same worker thread as every other touch of these fields, so no lock is needed. Calls
        /// EmitStatus itself on flush rather than leaving that to the caller, since every call
        /// site needs it and there is no other work to interleave in between.
        /// </summary>
        private void MaybeFlushStatsWindow()
        {
            double elapsedMs = statsWindowStopwatch.Elapsed.TotalMilliseconds;
            if (elapsedMs < StatsWindowMs) return;

            int attempted = framesRenderedInWindow + framesDroppedForBackpressureInWindow;
            lastFps = framesRenderedInWindow / (elapsedMs / 1000.0);
            lastAvgRenderMs = framesRenderedInWindow > 0 ? renderMsSumInWindow / framesRenderedInWindow : 0;
            lastDropRate = attempted > 0 ? (double)framesDroppedForBackpressureInWindow / attempted : 0;

            framesRenderedInWindow = 0;
            renderMsSumInWindow = 0;
            framesDroppedForBackpressureInWindow = 0;
            statsWindowStopwatch.Restart();
            EmitStatus();
        }

        /// <summary>
        /// UI-thread only. The one place <see cref="imageSource"/> is ever constructed or drawn
        /// into - see this class's header comment for why that split exists.
        /// </summary>
        private void Present(CanvasRenderTarget target, int width, int height, bool upscaled)
        {
            try
            {
                if (imageSource == null || presentedWidth != width || presentedHeight != height)
                {
                    // Sized to whatever pixelEffect.Render actually produced - native resolution
                    // for plain pass-through (family unsupported, or an error fell back to
                    // target), or the fixed 2x scale once a real chain is running.
                    imageSource = new CanvasImageSource(canvasDevice, width, height, 96);
                    presentedWidth = width;
                    presentedHeight = height;
                    Element.Source = imageSource;
                }

                using (CanvasDrawingSession ds = imageSource.CreateDrawingSession(Windows.UI.Colors.Black))
                {
                    ds.DrawImage(target);
                }

                if (!receivedFrame || upscaledLastFrame != upscaled)
                {
                    receivedFrame = true;
                    upscaledLastFrame = upscaled;
                    lastError = null;
                    EmitStatus();
                }
            }
            catch (Exception ex)
            {
                ReportError(ex);
            }
        }

        private void ReportError(Exception ex)
        {
            string message = $"{ex.GetType().Name}: {ex.Message}";
            log($"[aiupscale] error: {message}");
            if (lastError != message)
            {
                lastError = message;
                EmitStatus();
            }
        }

        private void EmitStatus()
        {
            // Formatted to a string first, then interpolated as a bare token with no :format left
            // inside any hole - the same fix NativePlayerHost.cs's contentAnalysis emit needed
            // (see its own comment) for a real .NET Native (UWP AOT) bug where a composite-format
            // hole sitting immediately against a JSON template's closing braces gets mis-lowered,
            // leaking the format specifier itself into the output as a literal token.
            string fpsStr = lastFps.ToString("R", CultureInfo.InvariantCulture);
            string avgRenderMsStr = lastAvgRenderMs.ToString("R", CultureInfo.InvariantCulture);
            string dropRateStr = lastDropRate.ToString("R", CultureInfo.InvariantCulture);
            emit?.Invoke("aiUpscaleStatus",
                $"{{\"active\":{(active ? "true" : "false")}," +
                $"\"receivedFrame\":{(receivedFrame ? "true" : "false")}," +
                $"\"upscaled\":{(upscaledLastFrame ? "true" : "false")}," +
                $"\"family\":{JsonString(family)}," +
                $"\"fps\":{fpsStr}," +
                $"\"avgRenderMs\":{avgRenderMsStr}," +
                $"\"dropRate\":{dropRateStr}," +
                $"\"error\":{JsonString(lastError)}}}");
        }

        // Minimal JSON string escaping, enough for an exception message - mirrors
        // NativePlayerHost's own JsonString helper (kept local since this class shouldn't need to
        // reach into that one for a two-line utility).
        private static string JsonString(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
                               .Replace("\r", " ").Replace("\n", " ") + "\"";
        }

        private CanvasRenderTarget EnsureFrameTarget()
        {
            if (frameTarget != null
                && frameTarget.SizeInPixels.Width == (uint)frameWidth
                && frameTarget.SizeInPixels.Height == (uint)frameHeight)
            {
                return frameTarget;
            }

            frameTarget?.Dispose();
            frameTarget = new CanvasRenderTarget(canvasDevice, frameWidth, frameHeight, 96);
            return frameTarget;
        }
    }
}
