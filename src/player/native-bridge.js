import { registerPlugin } from "@capacitor/core";
import { plexAssetUrl } from "./core/plex-asset-url.js";
import { playQueuedTitle } from "./ui/chrome.js";

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
    /* PlayerUiHelper's own title-prev/title-next buttons (mirroring chrome.js's
       makeTitleNavButton) only need queueLength/queueIndex to decide whether to grey
       "next" out and whether "prev" should restart vs jump back - the actual Plex
       metadata fetch for whichever adjacent title gets requested stays here, reusing
       chrome.js's playQueuedTitle rather than reimplementing that fetch-then-_switchTitle
       sequence in Java. */
    controller._nativeListenerHandles.push(
        await NativePlayer.addListener("titleNav", ({ index }) => {
            const queue = controller._session?.queueRatingKeys || [];
            playQueuedTitle(controller, queue, index);
        })
    );
    await NativePlayer.play(buildPlaybackPayload(controller, streamUrl, startOffsetMs));
}

/* The {url, shaderType, chapters, bifUrl, audioStreams, title/episodeTitle/year/
   seasonNumber/episodeNumber, queueLength/queueIndex} shape both a cold play() and an
   in-place switchTitle() send over the bridge - shared so the two never drift apart on
   what Java expects a title's metadata to look like. */
function buildPlaybackPayload(controller, streamUrl, startOffsetMs) {
    return {
        url: streamUrl,
        startPositionMs: startOffsetMs,
        /* PlayerActivity only ever sees the already-detected type (never "off") - it
           doesn't run its own genre detection, so there's one detection implementation
           instead of one per platform. shaderEnabled/upscaleStrength/upscaleAuto are
           NOT passed here - PlayerActivity owns those itself now (its own
           SharedPreferences-persisted state, see PREF_UPSCALE_ENABLED and friends), same
           immediate-persistence model as colorBoostEnabled/colorBoostStrength/
           colorBoostAuto, which never traveled through this bridge either. */
        shaderType: controller._shaderAutoType,
        /* Native code only ever sees {title, startTimeOffsetMs, thumbUrl} - it doesn't
           need to know Plex's own Chapter field names, keeping that one Plex-protocol
           interpretation here instead of duplicated into Java. thumbUrl is a full,
           already-tokened URL (not a bare Plex path) since Java has no equivalent of
           this module's session-scoped plexAssetUrl to finish building it itself. */
        chapters: (controller._session.chapters || []).map((c) => ({
            title: c.title || c.tag || "",
            startTimeOffsetMs: c.startTimeOffset ?? 0,
            thumbUrl: plexAssetUrl(controller._session, c.thumb),
        })),
        /* Full BIF trickplay index URL (see src/player/core/bif.js for the web
           equivalent) - Java parses/fetches this itself (BifIndex.java) rather than
           this bridge doing it and shipping frames over, since individual frames are
           only needed on demand as the user drags, not all up front. */
        bifUrl: plexAssetUrl(controller._session, controller._session.bifIndexPath),
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
        episodeTitle: controller._session.episodeTitle || null,
        year: controller._session.year ?? null,
        seasonNumber: controller._session.seasonNumber ?? null,
        episodeNumber: controller._session.episodeNumber ?? null,
        /* Only the count and current position travel over the bridge - the actual
           ratingKeys never need to reach Java, since a title-nav tap is reported back as
           a plain index (see the "titleNav" listener above) and resolved against this
           module's own queueRatingKeys copy. */
        queueLength: controller._session.queueRatingKeys?.length ?? 0,
        queueIndex: controller._session.queueIndex ?? null,
    };
}

/* Swaps the currently playing title in PlayerActivity in place - no Intent, no
   startActivityForResult, same running Activity/ExoPlayer instance - rather than a full
   stop()+play() (finish() the Activity, launch a fresh one), which is what used to make
   title-prev/title-next visibly swipe the whole window out and back in for what should
   read as one continuous player. No listener re-registration needed here: PlayerActivity
   stays alive the whole time, so the progress/ended/error/stopped/titleNav listeners
   playNative already wired up above keep firing for the new title too. */
export async function switchNative(controller, streamUrl, startOffsetMs) {
    await NativePlayer.switchTitle(buildPlaybackPayload(controller, streamUrl, startOffsetMs));
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
