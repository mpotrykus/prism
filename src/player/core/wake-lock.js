/* Screen Wake Lock API - keeps the device from sleeping during the <video>+hls.js fallback
   (web-fallback.js). Only reachable by real browsers: Android and Xbox/PC both route through a
   native playback bridge instead (native-bridge.js / xbox-bridge.js), each with its own
   platform-native keep-awake (Android's PlayerActivity sets FLAG_KEEP_SCREEN_ON; the UWP shell's
   NativePlayerHost holds a DisplayRequest) - this covers the one leg neither of those reaches. */
let visibilityListenerAttached = false;

export async function acquireWakeLock(controller) {
    if (!("wakeLock" in navigator)) return;
    try {
        controller._wakeLock = await navigator.wakeLock.request("screen");
    } catch {
        /* Throws if the document isn't visible at the moment of the request (e.g. a
           backgrounded tab) - the visibilitychange listener below retries once it's visible
           again, so this failure is never fatal to playback starting. */
        controller._wakeLock = null;
    }
    /* The browser silently releases the lock whenever the tab is hidden, with no event on the
       lock itself for that - so re-request on the next return to "visible" while a session is
       still open. Attached once for the module's lifetime, not once per playback session:
       `controller` is the app's one singleton (plex-player.js's `export const player`). */
    if (!visibilityListenerAttached) {
        visibilityListenerAttached = true;
        document.addEventListener("visibilitychange", () => {
            if (
                document.visibilityState === "visible" &&
                controller._session &&
                controller._session.state !== "paused" &&
                !controller._wakeLock
            ) {
                acquireWakeLock(controller);
            }
        });
    }
}

export function releaseWakeLock(controller) {
    controller._wakeLock?.release().catch(() => {});
    controller._wakeLock = null;
}
