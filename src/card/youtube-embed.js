/* The raw postMessage protocol for a YouTube trailer <iframe>, shared by the hero banner and
   the title-info modal - the two places in the app that embed one.

   No official iframe_api script is loaded, so this protocol is the only way to control the
   embed or detect that it ended. Both of the non-obvious behaviours it has to work around are
   handled here rather than at each call site:

   - The player isn't ready to receive commands the instant the iframe fires "load", and there
     is no readiness signal to wait on, so setPlaybackQuality is retried over ~2s.
     setPlaybackQuality is advisory (YouTube can still downgrade for bandwidth), but without it
     the embed picks a noticeably lower auto quality.
   - Sending a command before the embed's own autoplay sequence has settled - pauseVideo in
     particular - can leave it permanently stuck on its unstarted/thumbnail state, ignoring
     every later command including playVideo (reproduced on the HA Companion app's WebView).
     Anything that corrects playback state has to be deferred, which is what `onSettled` is
     for. */

const QUALITY_RETRIES = 8;
const QUALITY_RETRY_INTERVAL_MS = 250;
const SETTLE_MS = 400;

export function postYtCommand(iframe, func, args = []) {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

/* Call from the iframe's own "load" listener. `id` is the handshake name YouTube echoes back;
   it only has to be unique per embed. `unmute` re-applies an unmuted preference, since the
   embed URL always starts muted regardless of what the user last chose. `onSettled` runs once
   the natural autoplay has had a chance to start. */
export function primeYtEmbed(iframe, { id, unmute = false, onSettled = null } = {}) {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id }), "*");
    if (unmute) postYtCommand(iframe, "unMute");
    if (onSettled) setTimeout(onSettled, SETTLE_MS);
    for (let i = 0; i < QUALITY_RETRIES; i++) {
        setTimeout(() => postYtCommand(iframe, "setPlaybackQuality", ["highres"]), i * QUALITY_RETRY_INTERVAL_MS);
    }
}

/* Both embeds can be live at once (the title-info modal sits on top of the hero, not instead
   of it) and every listener sees every "message" on the window, so `getIframe` is re-read per
   event to check the source - otherwise one trailer ending would end the other too.

   onError is the only safeguard left against an age-restricted or embedding-disabled video:
   TMDB's videos endpoint doesn't expose either flag (unlike the YouTube Data API call it
   replaced, which let the caller pre-filter them out), and YouTube posts an error here instead
   of ever reaching a playerState. Without it the embed just sits there dead and silent. */
export function listenToYtEmbed(getIframe, { onEnded, onPlaying, onError = onEnded } = {}) {
    window.addEventListener("message", (e) => {
        if (e.source !== getIframe()?.contentWindow) return;
        if (typeof e.data !== "string") return;
        let data;
        try {
            data = JSON.parse(e.data);
        } catch (err) {
            return;
        }
        if (data.event === "infoDelivery" && data.info?.playerState === 0) onEnded?.();
        if (data.event === "infoDelivery" && data.info?.playerState === 1) onPlaying?.();
        const errorCode = data.event === "onError" ? data.info : data.info?.errorCode;
        if (errorCode !== undefined) onError?.();
    });
}
