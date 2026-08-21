using System;
using System.Threading.Tasks;
using Windows.Graphics.Display.Core;

namespace PrismUwp.Player
{
    /// <summary>
    /// Switches the console's HDMI output into and out of HDR10 around playback.
    ///
    /// This is the second half of HDR on Xbox. The first half is the media pipeline itself, which
    /// passes HDR10 through without any custom rendering - Microsoft documents that SDR content plays
    /// in HDR modes and HDR content plays tone-mapped in SDR modes, both handled inside the pipeline
    /// (learn.microsoft.com/windows/uwp/audio-video-camera/hevc-xbox). So no DX11 swapchain, no
    /// SetColorSpace1 and no tone-mapping shader are needed here; only the output mode has to be told
    /// what is coming.
    ///
    /// Modelled on moonlight-xbox's MoonlightClient::SetDisplayHDR, which is the proof this works on
    /// this exact hardware. Notably it needs no manifest capability of its own - HdmiDisplayInformation
    /// is plain UniversalApiContract. hevcPlayback is for HEVC decode, not for this.
    /// </summary>
    internal sealed class HdrDisplayController
    {
        private readonly Action<string> log;
        private bool weSwitchedToHdr;

        public HdrDisplayController(Action<string> log)
        {
            this.log = log ?? (_ => { });
        }

        public bool IsHdrActive { get; private set; }

        /// <summary>
        /// Puts the display into an HDR10 mode matching the current resolution and refresh rate.
        /// Returns false when that isn't possible, which is a normal outcome (SDR TV, or the console
        /// isn't running at a resolution with an HDR variant) and not an error - playback continues in
        /// SDR, tone-mapped by the media pipeline.
        /// </summary>
        public async Task<bool> EnableAsync()
        {
            HdmiDisplayInformation hdmi = HdmiDisplayInformation.GetForCurrentView();
            // Null off-Xbox (desktop WebView2 host, or a non-HDMI display path). Every call site in
            // moonlight-xbox null-checks this for the same reason.
            if (hdmi == null)
            {
                log("HDR: no HDMI display information available");
                return false;
            }

            HdmiDisplayMode current = hdmi.GetCurrentDisplayMode();
            if (current == null) return false;
            if (current.IsSmpte2084Supported)
            {
                // Already in an HDR mode - someone else put it there, so leave ownership alone and do
                // not restore it on exit either.
                log("HDR: display already in an HDR mode");
                IsHdrActive = true;
                return true;
            }

            // Xbox warns HDR is often unavailable below native 4K. Logged rather than enforced: it is
            // the TV and mode list that decide, and the search below simply finds nothing if so.
            if (current.ResolutionWidthInRawPixels < 3840)
            {
                log($"HDR: display is {current.ResolutionWidthInRawPixels}px wide - HDR may be unavailable below 4K");
            }

            HdmiDisplayMode target = FindMatchingHdrMode(hdmi, current);
            if (target == null)
            {
                log("HDR: no matching HDR mode for the current resolution/refresh rate - staying SDR");
                return false;
            }

            // Metadata is BT.2020 primaries with a D65 white point and conventional HDR10 mastering
            // luminance. Plex does not reliably expose per-title MaxCLL or mastering-display values,
            // and the authoritative metadata travels in the HEVC bitstream's own SEI messages, which
            // the media pipeline forwards regardless of what is passed here. moonlight-xbox zeroes
            // this struct outright when its host provides nothing.
            var metadata = new HdmiDisplayHdr2086Metadata
            {
                RedPrimaryX = 34000, RedPrimaryY = 16000,
                GreenPrimaryX = 13250, GreenPrimaryY = 34500,
                BluePrimaryX = 7500, BluePrimaryY = 3000,
                WhitePointX = 15635, WhitePointY = 16450,
                // CTA-861.3 units, and the two luminance fields do NOT share a scale: max mastering
                // luminance is in whole cd/m² (1000 = 1000 nits) while min is in 0.0001 cd/m²
                // (50 = 0.005 nits). Both are ushort, so scaling max by 10000 as if it matched min
                // doesn't just misreport - it fails to compile.
                MaxMasteringLuminance = 1000,
                MinMasteringLuminance = 50,
                MaxContentLightLevel = 1000,
                MaxFrameAverageLightLevel = 400,
            };

            bool applied;
            try
            {
                applied = await hdmi.RequestSetCurrentDisplayModeAsync(
                    target, HdmiDisplayHdrOption.Eotf2084, metadata);
            }
            catch (Exception ex)
            {
                log($"HDR: mode change threw 0x{ex.HResult:X8}");
                return false;
            }

            // The API can report success while the TV lands somewhere else - moonlight-xbox's code
            // carries an explicit "sometimes this lies" note about exactly this - so the current mode
            // is re-read and believed over the return value.
            IsHdrActive = applied && (hdmi.GetCurrentDisplayMode()?.IsSmpte2084Supported ?? false);
            weSwitchedToHdr = IsHdrActive;
            log(IsHdrActive ? "HDR: display switched to HDR10" : "HDR: mode change did not take effect");
            return IsHdrActive;
        }

        /// <summary>
        /// Returns the display to its default (SDR) mode, but only if this class is what moved it.
        ///
        /// Must be called on every exit path - playback stopping, suspend, and app close. moonlight-xbox
        /// restores only on explicit disconnect and leaves the console stuck in HDR when killed
        /// mid-stream; that bug is worth not inheriting. Microsoft also recommends restoring because
        /// app UI is not colour-converted accurately in HDR modes, text especially.
        /// </summary>
        public async Task RestoreAsync()
        {
            if (!weSwitchedToHdr) return;
            weSwitchedToHdr = false;
            IsHdrActive = false;
            try
            {
                HdmiDisplayInformation hdmi = HdmiDisplayInformation.GetForCurrentView();
                if (hdmi == null) return;
                await hdmi.SetDefaultDisplayModeAsync();
                log("HDR: display restored to default mode");
            }
            catch (Exception ex)
            {
                log($"HDR: restore threw 0x{ex.HResult:X8}");
            }
        }

        // Same resolution and refresh rate, not stereo, but with HDR support - i.e. the HDR twin of
        // whatever mode the console is already in. Switching resolution as well would change the whole
        // dashboard's output for the sake of playback.
        private static HdmiDisplayMode FindMatchingHdrMode(HdmiDisplayInformation hdmi, HdmiDisplayMode current)
        {
            foreach (HdmiDisplayMode mode in hdmi.GetSupportedDisplayModes())
            {
                if (mode.IsSmpte2084Supported
                    && !mode.StereoEnabled
                    && mode.ResolutionWidthInRawPixels == current.ResolutionWidthInRawPixels
                    && mode.ResolutionHeightInRawPixels == current.ResolutionHeightInRawPixels
                    && Math.Abs(mode.RefreshRate - current.RefreshRate) <= 0.00001)
                {
                    return mode;
                }
            }
            return null;
        }
    }
}
