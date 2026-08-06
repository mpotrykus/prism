import { SHADER_TYPES } from "./shader/shaders.js";
import { STATS_OVERLAY_STORAGE_KEY } from "./ui/shared.js";

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
function shaderStatusLine(controller) {
    if (controller._shaderType === "off") return "off";
    const label = SHADER_TYPES[controller._shaderType]?.label ?? controller._shaderType;
    return `${label} @ ${Math.round(controller._shaderStrength * 100)}%`;
}

function colorBoostStatusLine(controller) {
    return controller._colorBoostEnabled ? `${Math.round(controller._colorBoostStrength * 100)}%` : "off";
}

export function renderStatsOverlayFrame(controller) {
    const el = controller._statsOverlayEl;
    const video = controller._videoEl;
    if (!el || !video) return;
    const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
    const lines = [
        `${video.videoWidth || 0}x${video.videoHeight || 0}`,
        "HDR: n/a (browser)",
        `Shader Upscaling: ${shaderStatusLine(controller)}`,
        `Color Boost: ${colorBoostStatusLine(controller)}`,
        `Quality cap: ${controller._session?.qualityCapKbps ? controller._session.qualityCapKbps + " kbps" : "original"}`,
        quality ? `Dropped frames: ${quality.droppedVideoFrames}/${quality.totalVideoFrames}` : null,
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
