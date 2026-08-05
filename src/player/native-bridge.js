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
        /* PlayerActivity only ever sees the already-detected type (never "off" - that's
           what shaderEnabled/upscaleStrength below are for) - it doesn't run its own
           genre detection, so there's one detection implementation instead of one per
           platform. */
        shaderType: controller._shaderAutoType,
        /* Passed as two independent values, not pre-collapsed to 0 when disabled - the
           in-player Shader Upscaling toggle on the Android leg (PlayerActivity's
           setShaderEnabled) needs to restore whatever strength the slider was already at
           when re-enabled, the same "toggle and strength are independent" model
           shader-pipeline.js's setShaderEnabled/setShaderStrength use here. */
        shaderEnabled: controller._shaderEnabled,
        upscaleStrength: controller._shaderStrength,
        /* Native code only ever sees {title, startTimeOffsetMs} - it doesn't need to know
           Plex's own Chapter field names, keeping that one Plex-protocol interpretation
           here instead of duplicated into Java. */
        chapters: (controller._session.chapters || []).map((c) => ({
            title: c.title || c.tag || "",
            startTimeOffsetMs: c.startTimeOffset ?? 0,
        })),
        /* {id, label, selected} - PlayerActivity rebuilds the transcode URL itself when
           the user picks one (see switchAudioStream), it never needs the raw Plex Stream
           shape, just enough to preselect/checkmark the one already playing. */
        audioStreams: (controller._session.audioStreams || []).map((s) => ({
            id: String(s.id),
            label: s.label || "Unknown",
            selected: !!s.selected,
        })),
        /* Title/season-episode-or-year, shown in the transport bar header - same fields
           web-fallback.js's buildTransportBar reads off controller._session directly. */
        title: controller._session.title || "",
        year: controller._session.year ?? null,
        seasonNumber: controller._session.seasonNumber ?? null,
        episodeNumber: controller._session.episodeNumber ?? null,
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
