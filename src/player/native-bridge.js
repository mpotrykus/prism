import { registerPlugin } from "@capacitor/core";

const NativePlayer = registerPlugin("NativePlayer");

/* Android leg of playback (Capacitor's NativePlayerPlugin -> PlayerActivity/Media3
   ExoPlayer). Takes the StreamingPlayerController instance as an explicit first
   argument rather than being a method on it - this and web-fallback.js are two
   mutually-exclusive branches of the same controller, not independent objects, so they
   read/write the controller's session state directly rather than through a narrower
   interface. */
export async function playNative(controller, streamUrl, startOffsetMs) {
    controller._nativeListenerHandles.push(
        await NativePlayer.addListener("progress", ({ positionMs, durationMs }) => {
            if (!controller._session) return;
            controller._session.lastTimeMs = positionMs;
            if (durationMs) controller._session.durationMs = durationMs;
            const marker = controller._activeMarkerAt(positionMs);
            if (marker !== controller._activeSkipMarker) {
                controller._activeSkipMarker = marker;
                if (marker) {
                    NativePlayer.showSkipButton({ label: controller._skipLabelFor(marker), seekToMs: marker.endTimeOffset ?? 0 });
                } else {
                    NativePlayer.hideSkipButton();
                }
            }
        })
    );
    controller._nativeListenerHandles.push(
        await NativePlayer.addListener("ended", () => controller.stop())
    );
    controller._nativeListenerHandles.push(
        await NativePlayer.addListener("error", ({ message }) => {
            console.error("StreamingPlayer: native playback error -", message);
            controller.stop();
        })
    );
    controller._nativeListenerHandles.push(
        await NativePlayer.addListener("stopped", () => controller.stop())
    );
    await NativePlayer.play({
        url: streamUrl,
        startPositionMs: startOffsetMs,
        /* PlayerActivity only ever sees the already-detected type (never "off" - strength
           0 is what turns the shader off there, same as the web path's _shaderType
           collapsing to "off" below) and the resolved strength number - it doesn't run
           its own genre detection, so there's one detection implementation instead of
           one per platform. Gated on _shaderEnabled here rather than passing
           _shaderStrength as-is - that field now holds the slider's position independent
           of on/off (see setShaderEnabled), so an initial-launch session with upscaling
           disabled but a remembered non-zero strength must still start native playback
           with 0, not silently re-enable it on a platform with no toggle of its own. */
        shaderType: controller._shaderAutoType,
        upscaleStrength: controller._shaderEnabled ? controller._shaderStrength : 0,
        /* Native code only ever sees {title, startTimeOffsetMs} - it doesn't need to know
           Plex's own Chapter field names, keeping that one Plex-protocol interpretation
           here instead of duplicated into Java. */
        chapters: (controller._session.chapters || []).map((c) => ({
            title: c.title || c.tag || "",
            startTimeOffsetMs: c.startTimeOffset ?? 0,
        })),
        /* {id, label} only - PlayerActivity rebuilds the transcode URL itself when the
           user picks one (see switchAudioStream), it never needs the raw Plex Stream
           shape. */
        audioStreams: (controller._session.audioStreams || []).map((s) => ({
            id: String(s.id),
            label: s.label || "Unknown",
        })),
    });
}

export async function stopNative(controller) {
    controller._nativeListenerHandles.forEach((h) => h.remove());
    controller._nativeListenerHandles = [];
    try {
        await NativePlayer.stop();
    } catch (e) {
        // the native player may already be closed (user backed out of PlayerActivity)
    }
}

export async function pauseNative() {
    await NativePlayer.pause();
}

export async function resumeNative() {
    await NativePlayer.resume();
}

export async function setNativePlaybackRate(rate) {
    await NativePlayer.setPlaybackSpeed({ speed: rate });
}

export async function setNativeSubtitle(url, languageCode, mimeType) {
    await NativePlayer.setSubtitle({ url, languageCode, mimeType });
}
