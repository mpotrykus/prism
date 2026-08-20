import { SHADER_TYPES } from "./shader/shaders.js";
import { STATS_OVERLAY_STORAGE_KEY } from "./ui/shared.js";
import { COOLDOWN_MS, DOWNGRADE_CONFIRM_TICKS, STABILITY_WINDOW_TICKS, bandwidthSource } from "./core/abr.js";
import { media } from "./core/media-facade.js";

/* "Performance Overlay" hamburger-menu toggle - a small monospace stats readout pinned
   to the top-left corner, same "toggle IS the persisted setting" immediate-persistence
   model as ambient-pipeline.js's setAmbientEnabled (no per-video/genre concern of its
   own either). Unlike the shader/ambient pipelines, this owns no GL/canvas resources of
   its own - just a plain DOM element updated on an interval - so there's no ensure/
   compile step, only build-if-missing. */

const STATS_UPDATE_INTERVAL_MS = 500;

export function setStatsOverlayEnabled(controller, enabled) {
    controller._statsOverlayEnabled = enabled;
    localStorage.setItem(STATS_OVERLAY_STORAGE_KEY, enabled ? "1" : "0");
    updateStatsOverlayPipeline(controller);
}

export function updateStatsOverlayPipeline(controller) {
    if (!controller._statsOverlayEnabled) {
        stopStatsOverlayLoop(controller);
        if (controller._statsOverlayEl) controller._statsOverlayEl.style.display = "none";
        return;
    }
    if (!ensureStatsOverlay(controller)) {
        controller._statsOverlayEnabled = false;
        return;
    }
    controller._statsOverlayEl.style.display = "block";
    startStatsOverlayLoop(controller);
}

export function ensureStatsOverlay(controller) {
    if (controller._statsOverlayEl) return true;
    const el = document.createElement("div");
    el.className = "streaming-player-stats-overlay";
    Object.assign(el.style, {
        position: "fixed",
        top: "24px",
        left: "24px",
        zIndex: "10001",
        background: "rgba(0,0,0,0.55)",
        color: "#fff",
        font: "11px/1.6 'SFMono-Regular', Consolas, monospace",
        padding: "8px 10px",
        borderRadius: "6px",
        pointerEvents: "none",
        whiteSpace: "pre",
    });
    document.body.appendChild(el);
    controller._statsOverlayEl = el;
    return true;
}

export function startStatsOverlayLoop(controller) {
    if (controller._statsOverlayIntervalId) return;
    renderStatsOverlayFrame(controller);
    controller._statsOverlayIntervalId = setInterval(() => renderStatsOverlayFrame(controller), STATS_UPDATE_INTERVAL_MS);
}

export function stopStatsOverlayLoop(controller) {
    if (controller._statsOverlayIntervalId) {
        clearInterval(controller._statsOverlayIntervalId);
        controller._statsOverlayIntervalId = null;
    }
}

/* Browsers give no reliable way to read a <video> element's real color-space/transfer
   info without WebCodecs (see docs/plezy-player-comparison.md's HDR section) - shown as
   "n/a" rather than guessed, unlike Android's real isHdrContent() check off Format.colorInfo. */
/* Sharpening (the hand-written CAS/Anime4K unsharp-mask kernels) and AI Upscaling (the real
   Anime4K CNN / FSR 1 chains) are independent toggles now - split into their own status lines
   rather than one that used to silently swap shape depending on which was actually rendering. */
function sharpeningStatusLine(controller) {
    if (controller._shaderType === "off") return "off";
    const label = SHADER_TYPES[controller._shaderType]?.label ?? controller._shaderType;
    /* Resolves auto vs. manual the same way shader-pipeline.js's renderShaderFrame does
       - reading _shaderStrength directly here would show the frozen manual slider
       position instead of what's actually being applied whenever Auto is on. */
    const strength = controller._upscaleAuto ? (controller._autoUpscaleStrength ?? 0) : controller._shaderStrength;
    return `${label} @ ${Math.round(strength * 100)}%${controller._upscaleAuto ? " (auto)" : ""}`;
}

/* _shaderActivePreset is what chooseRenderPreset actually rendered last frame - the toggle
   being on doesn't mean this chain is the one currently drawing (the upscale gate may have
   declined, or the perf watchdog may have stepped it down), so this reports which of those
   is true rather than just echoing the toggle state back.

   No separate "Deband:" line exists any more - deband is now baked permanently into the
   CNN/FSR chains themselves (see shaders.js's debandPass), never into the sharpen presets, so
   it is active exactly when this line reports a running pass count and never otherwise. A
   dedicated line would just be restating this one. */
function aiUpscalingStatusLine(controller) {
    if (!controller._aiUpscalingEnabled) return "off";
    const familyKey = controller._shaderAutoType;
    const upgradeKey = SHADER_TYPES[familyKey]?.upgradeTo;
    const preset = upgradeKey ? SHADER_TYPES[upgradeKey] : null;
    if (!preset) return "not supported here";
    /* Xbox has no JS-side GL pass chain at all (native does the work - see
       AiUpscaleFrameServer) - _xboxIsHdr is set on every Xbox loadedMetadata regardless of
       whether AI Upscaling is even on, same detection hdrStatusLine already relies on, so this
       stays reliable even before any "aiUpscaleStatus" event has arrived. */
    if (controller._xboxIsHdr !== undefined) return xboxAiUpscalingStatusLine(controller, preset);
    if (controller._shaderChainErrors?.[upgradeKey]) return `${preset.label} failed to compile here`;
    if (!controller._shaderChains?.[upgradeKey]) return "not supported here";
    /* A trained network takes no strength, so printing one would be a fabricated number -
       the pass count and the watchdog's measured frame interval are the numbers that actually
       matter for a multi-pass chain. */
    if (controller._shaderActivePreset === upgradeKey) {
        return `${preset.label} (${activeChainPassCount(controller, upgradeKey) ?? preset.passes.length} passes)${watchdogSuffix(controller)}`;
    }
    if (controller._shaderWatchdog?.downgraded) return `${preset.label} off - too slow here`;
    return `${preset.label} idle - source not upscaled`;
}

/* Frame-server mode cannot render HDR (see AiUpscaleFrameServer's own header comment), so an
   HDR title never activates this path at all - reported distinctly from "off" since the toggle
   IS on, just inapplicable to this title. controller._session?.isHdr mirrors the same isHdr
   value already sent to native's Play/SwitchTitle (see xbox-bridge.js's playXbox/switchXbox),
   same field hdrStatusLine above already reads for the equivalent purpose. */
function xboxAiUpscalingStatusLine(controller, preset) {
    if (controller._session?.isHdr) return "unsupported (HDR)";
    const status = controller._xboxAiUpscaleStatus;
    if (!status) return "starting...";
    if (status.error) return `error: ${status.error}`;
    if (!status.receivedFrame) return "no frames received";
    /* preset is the resolved UPGRADE entry (e.g. SHADER_TYPES.anime4k_cnn, label "Animation (AI
       CNN)") - status.family is only the bare family key ("anime4k"), whose own label ("Animation")
       says nothing about the real CNN/FSR chain actually running. Real bug hit and fixed
       2026-08-20: this used to read SHADER_TYPES[status.family]?.label, which is always the plain
       family label - so "running" and "off" looked identical here, and toggling AI Upscaling
       produced no visible change in this line at all. */
    if (status.upscaled) return preset.label;
    // Native reports "not upscaled" for two different reasons: FSR1 (live-action) isn't ported
    // yet (Stage 2b), or an error mid-chain fell back to plain pass-through this frame (see
    // AiUpscalePixelEffect.Render's own null return / AiUpscaleFrameServer's catch fallback).
    if (status.family && status.family !== "anime4k") return `${status.family} not supported here yet`;
    return "pass-through (not upscaling)";
}

/* The measured shader-loop frame interval, and whether the perf watchdog has already stepped
   the chain down. Both only exist for multi-pass presets (see perf-watchdog.js on why the
   single-pass fallback isn't measured), so this contributes nothing on the sharpen path. */
function watchdogSuffix(controller) {
    const watchdog = controller._shaderWatchdog;
    if (!watchdog || !watchdog.meanFrameMs) return "";
    /* Both numbers, always - the earlier version printed "downgraded (too slow)" *instead of*
       the measurement, which is exactly the moment the measurement matters most. Diagnosing a
       downgrade on real hardware meant guessing whether the chain missed by 10% or 10x. The
       ratio is the interpretable one: 1.0 is real time, and anything under ~1.35 should not
       have tripped at all. */
    /* Drop rate is windowed, unlike the cumulative "Dropped frames" line above - a session
       total can't be A/B'd against toggling the preset, which is the whole point of showing it
       here. Also note the ratio saturates at 1.00 under frame-driven rendering: rVFC can't
       deliver frames faster than the source's rate, so 1.00 confirms "keeping up" but says
       nothing about how much headroom is left. */
    const dropped = watchdog.dropRate > 0 ? `, ${(watchdog.dropRate * 100).toFixed(1)}% dropped` : "";
    const measured = `${watchdog.meanFrameMs.toFixed(1)}ms/frame, ${watchdog.keepUpRatio.toFixed(2)}x real time${dropped}`;
    return watchdog.downgraded ? ` · downgraded (${measured})` : ` · ${measured}`;
}

/* The live chain's count, so Deband's extra pass is visible here too. */
function activeChainPassCount(controller, key) {
    return controller._shaderChains?.[key]?.passCount ?? null;
}

/* Saturation and Contrast are fully independent controls now (own enabled/auto, own
   Auto|On|Off mode - see shader-pipeline.js) - each shows "off" on its own if disabled,
   otherwise its own auto-derived value (avgSaturation-driven for Saturation, lumaStdDev-
   driven for Contrast) or its own remembered manual position. */
function colorBoostStatusLine(controller) {
    const satOn = controller._colorBoostSaturationEnabled;
    const conOn = controller._colorBoostContrastEnabled;
    if (!satOn && !conOn) return "off";
    const satAuto = controller._colorBoostSaturationAuto;
    const conAuto = controller._colorBoostContrastAuto;
    const saturation = satAuto ? (controller._autoColorBoostSaturationStrength ?? 0) : controller._colorBoostSaturationStrength;
    const contrast = conAuto ? (controller._autoColorBoostContrastStrength ?? 0) : controller._colorBoostContrastStrength;
    const satPart = satOn ? `sat ${Math.round(saturation * 100)}%${satAuto ? " (auto)" : ""}` : "sat off";
    const conPart = conOn ? `con ${Math.round(contrast * 100)}%${conAuto ? " (auto)" : ""}` : "con off";
    return `${satPart}, ${conPart}`;
}

function qualityCapStatusLine(controller) {
    const capKbps = controller._session?.qualityCapKbps;
    const label = capKbps ? `${capKbps} kbps` : "original";
    return `${label}${controller._autoQualityEnabled ? " (auto)" : ""}`;
}

/* <video> exposes no direct fps reading - approximated from getVideoPlaybackQuality's
   monotonic frame counter across two ticks (STATS_UPDATE_INTERVAL_MS apart), same
   "derive it from what the browser does give us" approach as the dropped-frames line
   below. Returns null on the first tick and right after a title switch resets the
   counter (negative delta) - self-corrects the following tick rather than showing a
   garbage spike. */
function sampleFrameRate(controller, quality) {
    const now = performance.now();
    const prev = controller._statsOverlayFpsSample;
    controller._statsOverlayFpsSample = { totalFrames: quality.totalVideoFrames, at: now };
    if (!prev) return null;
    const deltaFrames = quality.totalVideoFrames - prev.totalFrames;
    const deltaSeconds = (now - prev.at) / 1000;
    if (deltaFrames <= 0 || deltaSeconds <= 0) return null;
    return deltaFrames / deltaSeconds;
}

function resolutionLine(controller, video, quality) {
    const fps = quality ? sampleFrameRate(controller, quality) : null;
    const fpsPart = fps ? ` @ ${fps.toFixed(1)}fps` : "";
    return `${video.videoWidth || 0}x${video.videoHeight || 0}${fpsPart}`;
}

/* Only meaningful when abr.js has a registered bandwidth source - see updateAbrMonitor. */
/* The web leg genuinely cannot answer this: a browser has no way to read a <video>'s colour space or
   transfer function without WebCodecs, which is why this line was hardcoded "n/a (browser)". A native
   backend reports what its output is ACTUALLY doing (see NativePlayerHost's loadedMetadata), so on Xbox
   this distinguishes three real states rather than one placeholder: HDR requested by the source and
   active on the display, requested but not achieved (SDR TV, or no HDR mode at the current
   resolution), and plain SDR content. */
function hdrStatusLine(controller) {
    if (controller._xboxIsHdr === undefined) {
        return controller._session?.isHdr ? "HDR: source is HDR, output n/a (browser)" : "HDR: n/a (browser)";
    }
    if (controller._xboxIsHdr) return "HDR: HDR10 active";
    return controller._session?.isHdr ? "HDR: source is HDR, display did not switch" : "HDR: off (SDR source)";
}

function abrDebugLine(controller) {
    const source = bandwidthSource(controller);
    if (!controller._autoQualityEnabled) return null;
    const cooldownLeftMs = COOLDOWN_MS - (Date.now() - controller._abrLastSwitchAt);
    const cooldown = cooldownLeftMs > 0 ? `cooldown ${Math.ceil(cooldownLeftMs / 1000)}s` : "ready";
    /* Stall-driven backends have no kbps to show - saying so is more useful than an empty line or a
       fabricated number (see core/abr.js's setStallDrivenAbr). */
    if (!source) {
        if (!controller._abrStallDriven) return null;
        return `ABR: stall-driven, stable ${controller._abrStableStreak}/${STABILITY_WINDOW_TICKS}, ${cooldown}`;
    }
    if (!controller._abrHasRealSample) return "ABR: measuring bandwidth...";
    const bandwidthKbps = Math.round(source.bandwidthEstimate / 1000);
    return `ABR: ${bandwidthKbps}kbps, down ${controller._abrDowngradeStreak}/${DOWNGRADE_CONFIRM_TICKS}, stable ${controller._abrStableStreak}/${STABILITY_WINDOW_TICKS}, ${cooldown}`;
}

/* Plex's source-track label, not necessarily what's actually being decoded - Plex often
   downmixes/transcodes audio for HLS delivery, and there's no <video>-level API to read
   the real post-transcode codec/channel layout the way Android's Format can (see
   PlayerUiHelper.updateStatsOverlay's Audio line). Labeled "(source)" so this doesn't
   read as more precise than it is. */
function audioStatusLine(controller) {
    const streams = controller._session?.audioStreams;
    if (!streams?.length) return null;
    const streamId = controller._session.audioStreamId;
    const current = (streamId != null && streams.find((s) => s.id === streamId)) || streams.find((s) => s.selected) || streams[0];
    return `Audio: ${current.label} (source)`;
}

/* Seconds buffered ahead of the playhead - the range containing currentTime, not just
   buffered.end(buffered.length - 1), since a seek can leave an earlier, no-longer-
   relevant range in the TimeRanges list. */
function bufferHealthLine(video) {
    const buffered = video.buffered;
    for (let i = 0; i < buffered.length; i++) {
        if (video.currentTime >= buffered.start(i) && video.currentTime <= buffered.end(i)) {
            return `Buffer: ${(buffered.end(i) - video.currentTime).toFixed(1)}s`;
        }
    }
    return null;
}

export function renderStatsOverlayFrame(controller) {
    const el = controller._statsOverlayEl;
    /* Reads playback state through the facade rather than the <video> element, so a native
       backend can feed the same overlay. getVideoPlaybackQuality is already feature-detected
       below, which is what lets a backend that can't report frame counts degrade to omitting
       the fps/dropped-frame lines instead of breaking the whole overlay. */
    const video = media(controller);
    if (!el || !video) return;
    const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
    const lines = [
        resolutionLine(controller, video, quality),
        hdrStatusLine(controller),
        quality ? `Dropped frames: ${quality.droppedVideoFrames}/${quality.totalVideoFrames}` : null,
        audioStatusLine(controller),
        `Sharpening: ${sharpeningStatusLine(controller)}`,
        `AI Upscaling: ${aiUpscalingStatusLine(controller)}`,
        `Color Boost: ${colorBoostStatusLine(controller)}`,
        `Quality cap: ${qualityCapStatusLine(controller)}`,
        abrDebugLine(controller),
        bufferHealthLine(video),
    ].filter(Boolean);
    el.textContent = lines.join("\n");
}

export function teardownStatsOverlay(controller) {
    stopStatsOverlayLoop(controller);
    if (controller._statsOverlayEl) {
        controller._statsOverlayEl.remove();
        controller._statsOverlayEl = null;
    }
}
