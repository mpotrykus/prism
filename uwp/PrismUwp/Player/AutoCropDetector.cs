using System;
using Microsoft.Graphics.Canvas;
using Windows.Foundation;
using Windows.UI;

namespace PrismUwp.Player
{
    /// <summary>
    /// Confirmed crop insets, as fractions of the sampled frame's own width/height - same
    /// shape as auto-crop.js's own insets object ({top,bottom,left,right}, 0..1 fractions).
    /// Consumed by <see cref="AiUpscaleFrameServer.Present"/> to compute the DrawImage source
    /// rect for the zoom.
    /// </summary>
    internal struct CropInsets
    {
        public double Top, Bottom, Left, Right;
    }

    /// <summary>
    /// Detects, and hands back the fractions for, a baked-in-source-frame black-bar crop for
    /// <see cref="AiUpscaleFrameServer"/>'s non-HDR frame-server presentation path - the native
    /// counterpart to the web leg's src/player/auto-crop.js. Deliberately mirrors that file's
    /// algorithm and every one of its tuning constants exactly rather than re-deriving them -
    /// see auto-crop.js's own extensive header/constant comments for the full design
    /// rationale (why luma AND range both matter, why 3 samples 2s apart, why the safety
    /// margin, etc.); this class does not repeat that reasoning, only the numbers.
    ///
    /// HDR titles never reach this class at all - AiUpscaleFrameServer itself is not used for
    /// them (frame-server mode cannot render HDR, see that class's own header comment), so
    /// Auto-Crop is structurally out of scope for HDR, the same hard limitation the AI
    /// Upscaling CNN/FSR chain already has. This is a deliberate, documented limitation, not a
    /// bug - there is no workaround attempted here.
    ///
    /// UNCONFIRMED ON REAL XBOX HARDWARE. Built and compile-checked only (via
    /// `npm run xbox:build`) - not yet sideloaded and watched against a real matted-in-border
    /// title on a console, the same "confirmed on hardware" bar this project already tracks
    /// explicitly elsewhere (see e.g. the Xbox gamepad Guide focus-trap fix and the Xbox AI
    /// Upscaling HDR fix, both shipped with the same caveat until re-tested on real hardware).
    /// </summary>
    internal sealed class AutoCropDetector
    {
        // Mirrors auto-crop.js's own constants EXACTLY - see that file's header/constant
        // comments for the reasoning behind each one. Kept in lockstep on purpose: this is the
        // same algorithm reapplied to a different (native, decoded-frame) source, not a
        // separately re-tuned one.
        private const double BlackLumaThreshold = 10;
        private const double BlackRangeThreshold = 24;
        private const int SampleMaxDim = 200;
        private const double MinCropFraction = 0.01;
        private const double MaxCropFraction = 0.25;
        private const double CropSafetyMarginFraction = 0.012;
        private const double DetectMinTimeSec = 0.75;
        private const int ConfirmSampleCount = 3;
        private const double ConfirmSampleGapSec = 2;

        private readonly CanvasDevice device;
        private CanvasRenderTarget scratch;
        private int scratchWidth;
        private int scratchHeight;

        private bool enabled;
        private int frameWidth;
        private int frameHeight;
        private bool detectionComplete;
        private double nextSampleAtSeconds;
        private readonly RawBorders[] samples = new RawBorders[ConfirmSampleCount];
        private int sampleCount;

        /// <summary>
        /// Null until CONFIRM_SAMPLE_COUNT samples all agree there's a real border, or forever
        /// if they don't - see auto-crop.js's reconcileSamples' own comment for why "still
        /// detecting" and "detected nothing, title has no border" are deliberately not told
        /// apart, same here.
        ///
        /// Written only from ConsiderFrame (a background Media Foundation thread, same as
        /// AiUpscaleFrameServer.OnVideoFrameAvailable's own CopyFrameToVideoSurface call), read
        /// only from Present (dispatched to the UI thread from inside that same
        /// OnVideoFrameAvailable call, after ConsiderFrame has already run for that frame). No
        /// explicit lock: the write always happens-before the dispatcher hop that queues the
        /// matching Present call, so by the time any Present call observes this field it is
        /// reading a value that is at worst one frame stale, never mid-write - the same
        /// "no lock needed, worst case is a stale frame" tolerance this class's sibling fields
        /// (e.g. AiUpscaleFrameServer's own `family`) already rely on.
        /// </summary>
        public CropInsets? Insets { get; private set; }

        public AutoCropDetector(CanvasDevice device)
        {
            this.device = device;
        }

        /// <summary>
        /// See PlayerBridge.cs's "setAutoCrop" case / NativePlayerHost.SetAutoCrop. Takes
        /// effect immediately against whatever title is already playing (unlike AI Upscaling's
        /// own SetAiUpscaling, which only applies at the next Play/SwitchTitle) - restarting
        /// detection mid-session is cheap and the web leg's own setAutoCropEnabled does the
        /// same (see that function's own scheduleDetection call).
        /// </summary>
        public void SetEnabled(bool value)
        {
            enabled = value;
            if (!value)
            {
                Insets = null;
                return;
            }
            Insets = null;
            // frameWidth/frameHeight are already valid here in every real case - Reset()
            // always runs (from ConfigureSize) before a viewer could ever reach this toggle in
            // the in-player menu - but guarded anyway since detection cannot size its scratch
            // target from a 0x0 frame.
            detectionComplete = frameWidth <= 0 || frameHeight <= 0;
            nextSampleAtSeconds = DetectMinTimeSec;
            sampleCount = 0;
        }

        /// <summary>
        /// Per-title reset - called from AiUpscaleFrameServer.ConfigureSize, the first point
        /// real decoded dimensions are known for THIS title (mirrors auto-crop.js's own
        /// updateAutoCropPipeline, called once the web leg's &lt;video&gt; element has real
        /// videoWidth/videoHeight to read). Not called from SetActive/SetFamily (the other
        /// per-title resets on the sibling class) - those run at Play/SwitchTitle, before the
        /// new title's real dimensions are known, so resetting insets there too would only add
        /// a redundant clear with nothing to size a fresh detection window against yet.
        /// ConfigureSize always runs before any real frame of the new title reaches
        /// OnVideoFrameAvailable (see that method's own doc comment), so there is no window
        /// where a stale crop from the previous title could still be applied to a new one.
        /// </summary>
        public void Reset(int videoWidth, int videoHeight)
        {
            frameWidth = videoWidth;
            frameHeight = videoHeight;
            Insets = null;
            detectionComplete = !enabled || videoWidth <= 0 || videoHeight <= 0;
            nextSampleAtSeconds = DetectMinTimeSec;
            sampleCount = 0;
        }

        /// <summary>
        /// Called from OnVideoFrameAvailable's own worker thread for every decoded frame - same
        /// thread-affinity reasoning as that method's own CopyFrameToVideoSurface/
        /// pixelEffect.Render calls (CanvasRenderTarget/CanvasDrawingSession have no UI-thread
        /// affinity). A cheap no-op on nearly every call (`detectionComplete` after the first
        /// CONFIRM_SAMPLE_COUNT samples, or whenever disabled) - the real downsample+scan work
        /// below only ever runs up to 3 times per title, so this does not regress the steady-
        /// state frame throughput/backpressure OnVideoFrameAvailable's own `framePending`
        /// comment already documents as a carefully-managed tradeoff.
        ///
        /// `rawFrame` must be the frame BEFORE pixelEffect.Render runs - detection has to read
        /// the true source picture, not a CNN/FSR-upscaled reinterpretation of it, the same
        /// reason the web leg samples the raw &lt;video&gt; element rather than its own shader
        /// canvas (see auto-crop.js's header comment). `positionSeconds` mirrors that file's use
        /// of video.currentTime for scheduling the 0.75s start and the 2s gaps between samples.
        /// </summary>
        public void ConsiderFrame(CanvasRenderTarget rawFrame, double positionSeconds)
        {
            if (!enabled || detectionComplete) return;
            if (positionSeconds < nextSampleAtSeconds) return;
            try
            {
                samples[sampleCount++] = SampleBorders(rawFrame);
            }
            catch (Exception)
            {
                // Fails this title's detection closed instead of crashing the frame pipeline -
                // same "a failed sample fails the whole reconciliation" philosophy
                // reconcileSamples in auto-crop.js applies (there triggered by a tainted-canvas
                // read failure; here by a native read failure - device lost, OOM - that a
                // partial sample list couldn't recover from either way).
                detectionComplete = true;
                Insets = null;
                return;
            }
            nextSampleAtSeconds += ConfirmSampleGapSec;
            if (sampleCount >= ConfirmSampleCount)
            {
                Insets = Reconcile(samples);
                detectionComplete = true;
            }
        }

        /// <summary>
        /// Downscales `rawFrame` to ~SampleMaxDim on its longer edge into a small reusable
        /// scratch CanvasRenderTarget, then reads that back - the same "detection scan is O(edge
        /// pixels), keep it cheap" reasoning as auto-crop.js's own SAMPLE_MAX_DIM comment, just
        /// applied via Win2D's DrawImage downscale instead of a &lt;canvas&gt; 2D context.
        /// </summary>
        private RawBorders SampleBorders(CanvasRenderTarget rawFrame)
        {
            double scale = Math.Min(1.0, SampleMaxDim / (double)Math.Max(frameWidth, frameHeight));
            int w = Math.Max(1, (int)Math.Round(frameWidth * scale));
            int h = Math.Max(1, (int)Math.Round(frameHeight * scale));
            EnsureScratch(w, h);

            using (CanvasDrawingSession ds = scratch.CreateDrawingSession())
            {
                ds.Clear(Colors.Black);
                ds.DrawImage(rawFrame, new Rect(0, 0, w, h), rawFrame.Bounds);
            }
            byte[] data = scratch.GetPixelBytes();
            return RawDetectBorders(data, w, h);
        }

        private void EnsureScratch(int w, int h)
        {
            if (scratch != null && scratchWidth == w && scratchHeight == h) return;
            scratch?.Dispose();
            scratch = new CanvasRenderTarget(device, w, h, 96);
            scratchWidth = w;
            scratchHeight = h;
        }

        // GetPixelBytes() returns B8G8R8A8 (CanvasRenderTarget's default DirectXPixelFormat),
        // NOT the RGBA order auto-crop.js's ImageData uses - so the channel indices below are
        // B,G,R,A rather than that file's R,G,B,A. The luma formula itself is unchanged
        // (0.299*R + 0.587*G + 0.114*B), it just reads R and B from swapped offsets.
        private static (double avg, double range) RowLumaStats(byte[] data, int w, int y)
        {
            double sum = 0;
            double min = 255;
            double max = 0;
            int rowStart = y * w * 4;
            for (int x = 0; x < w; x++)
            {
                int i = rowStart + x * 4;
                double luma = 0.299 * data[i + 2] + 0.587 * data[i + 1] + 0.114 * data[i];
                sum += luma;
                if (luma < min) min = luma;
                if (luma > max) max = luma;
            }
            return (sum / w, max - min);
        }

        private static (double avg, double range) ColLumaStats(byte[] data, int w, int h, int x)
        {
            double sum = 0;
            double min = 255;
            double max = 0;
            for (int y = 0; y < h; y++)
            {
                int i = (y * w + x) * 4;
                double luma = 0.299 * data[i + 2] + 0.587 * data[i + 1] + 0.114 * data[i];
                sum += luma;
                if (luma < min) min = luma;
                if (luma > max) max = luma;
            }
            return (sum / h, max - min);
        }

        private static bool IsBlack((double avg, double range) stats) =>
            stats.avg < BlackLumaThreshold && stats.range < BlackRangeThreshold;

        // Direct port of auto-crop.js's rawDetectBorders - same scan-inward-per-edge, same
        // MAX_CROP_FRACTION scan cap, same MIN_CROP_FRACTION floor. Raw (no safety margin) -
        // Reconcile below is the only caller, same reasoning as the JS version: samples need
        // comparing edge-by-edge before either the "no crop" or "pad the confirmed edges"
        // decision can be made.
        private static RawBorders RawDetectBorders(byte[] data, int w, int h)
        {
            int maxY = Math.Max(1, (int)Math.Floor(h * MaxCropFraction));
            int maxX = Math.Max(1, (int)Math.Floor(w * MaxCropFraction));

            int top = 0;
            while (top < maxY && IsBlack(RowLumaStats(data, w, top))) top++;
            int bottom = 0;
            while (bottom < maxY && IsBlack(RowLumaStats(data, w, h - 1 - bottom))) bottom++;
            int left = 0;
            while (left < maxX && IsBlack(ColLumaStats(data, w, h, left))) left++;
            int right = 0;
            while (right < maxX && IsBlack(ColLumaStats(data, w, h, w - 1 - right))) right++;

            double topFrac = top / (double)h;
            double bottomFrac = bottom / (double)h;
            double leftFrac = left / (double)w;
            double rightFrac = right / (double)w;
            if (topFrac < MinCropFraction) topFrac = 0;
            if (bottomFrac < MinCropFraction) bottomFrac = 0;
            if (leftFrac < MinCropFraction) leftFrac = 0;
            if (rightFrac < MinCropFraction) rightFrac = 0;
            return new RawBorders { Top = topFrac, Bottom = bottomFrac, Left = leftFrac, Right = rightFrac };
        }

        // Takes the MIN per edge across all ConfirmSampleCount samples, independently - see
        // auto-crop.js's reconcileSamples' own comment for why this alone tells a real border
        // (reads the same every sample) apart from a dark scene (rarely survives the whole
        // multi-second spread unchanged) without a separate tolerance/agreement check. Unlike
        // the JS version there is no per-sample null case to guard here: ConsiderFrame only
        // ever appends a sample after SampleBorders succeeds, and fails the whole title closed
        // immediately on any exception rather than leaving a null hole in the array.
        private static CropInsets? Reconcile(RawBorders[] samples)
        {
            double top = samples[0].Top, bottom = samples[0].Bottom, left = samples[0].Left, right = samples[0].Right;
            for (int i = 1; i < samples.Length; i++)
            {
                if (samples[i].Top < top) top = samples[i].Top;
                if (samples[i].Bottom < bottom) bottom = samples[i].Bottom;
                if (samples[i].Left < left) left = samples[i].Left;
                if (samples[i].Right < right) right = samples[i].Right;
            }
            if (top == 0 && bottom == 0 && left == 0 && right == 0) return null;
            // Margin only pads an edge every sample agreed on, then re-clamps to
            // MaxCropFraction - same reasoning as CROP_SAFETY_MARGIN_FRACTION's own comment in
            // auto-crop.js.
            double Pad(double f) => f > 0 ? Math.Min(MaxCropFraction, f + CropSafetyMarginFraction) : 0;
            return new CropInsets { Top = Pad(top), Bottom = Pad(bottom), Left = Pad(left), Right = Pad(right) };
        }

        private struct RawBorders
        {
            public double Top, Bottom, Left, Right;
        }
    }
}
