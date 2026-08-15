/* Phase 0 hardware-spike harness for the Xbox native player. Temporary by design: this
   exists only to answer four questions on a real console before any of Phase 2's bridge is
   worth building, and should be deleted once those answers are recorded in
   docs/xbox-native-hdr-player/.

     S1  Does a transparent WebView2 actually composite over a MediaPlayerElement on Xbox,
         and at what cost at 4K? (showTestOverlay below is what you look at.)
     S2  Does AdaptiveMediaSource accept Plex's own start.m3u8? (answered natively - this
         file's only job is handing native a real, tokened URL to try.)
     S3  Do JS timers and fetch keep running while native video is foregrounded? Android's
         WebView.onPause() suspended all network loading, which silently killed /:/timeline
         reporting for the whole duration of playback. WebView2 is a different engine in a
         different lifecycle model, so this measures rather than assumes.
     S4  Does gamepad focus still behave with a second XAML element in the tree? (answered
         natively, by logging the focused element on each key press.)

   Deliberately inert unless the Xbox shell is driving it: every entry point below no-ops
   when window.chrome.webview is absent, so web and Android are untouched. It also does NOT
   set the platform marker core/platform.js looks for - doing that would flip
   hasNativePlayer() to true and route playback into native-bridge.js's Capacitor plugin,
   which does not exist on Xbox, breaking the working <video>+hls.js player this spike needs
   to keep running underneath it. */

const HEARTBEAT_MS = 1000;

function bridge() {
    return typeof window !== "undefined" ? window.chrome?.webview : null;
}

/* Posts a JSON STRING, not the object. Posting the object read better and is what the docs
   describe, but on the Xbox WebView2 runtime nothing sent that way ever reached
   CoreWebView2.WebMessageReceived - not the app's own messages and not a probe injected before
   any app module evaluated - while native->JS PostWebMessageAsJson worked fine the whole time.
   A string payload is the more conservative form and is what TryGetWebMessageAsString expects,
   so native accepts either shape now.

   Carry forward the Android bridge's hard-won rule when this becomes the real Phase 2
   bridge: any Plex-sourced numeric id (partId, audioStreams[].id) must be String()-coerced
   before it crosses, and the native side should assert on a number arriving where a string
   is expected rather than letting it become null. This message-envelope problem is the same
   class of bug one level up - the transport's own type fidelity, not a field's. */
function post(message) {
    try {
        bridge()?.postMessage(JSON.stringify(message));
    } catch (e) {
        console.warn("[xbox-spike] postMessage failed -", e);
    }
}

let heartbeatTimer = null;
let heartbeatTick = 0;
let probeOrigin = null;
let overlayEl = null;
let savedBackgrounds = null;

/* Called whenever the JS side builds a real transcode URL, so native has something
   genuine (right server, right token, right params) to probe AdaptiveMediaSource with
   rather than a synthetic manifest that would prove nothing about Plex's actual output. */
export function reportStreamUrl(url) {
    if (!bridge() || !url) return;
    try {
        probeOrigin = new URL(url).origin;
    } catch {
        probeOrigin = null;
    }
    /* Parked on window as well as posted, so native has a second, independent way to get at it.
       postMessage is the channel Phase 2's real bridge will use, but ExecuteScriptAsync is the
       one already proven to work on this shell (the gamepad key forwarding runs through it), so
       if the message channel turns out to be the broken half, native can still pull this and S2
       stays answerable. */
    window.__prismSpikeStreamUrl = url;
    post({ type: "spikeStreamUrl", url });
}

/* S3. A bare setInterval would only prove timers still fire; the fetch is the part that
   actually mattered on Android, where the timer was frozen AND network loading was
   suspended. Plex's /identity needs no token and is the cheapest endpoint that still
   exercises a real cross-origin request to the same server playback is streaming from. */
function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTick = 0;
    heartbeatTimer = setInterval(async () => {
        const tick = ++heartbeatTick;
        const startedAt = Date.now();
        let fetchOk = null;
        let fetchMs = null;
        if (probeOrigin) {
            try {
                /* no-cors, and "the promise resolved" is the success signal rather than res.ok.
                   The question here is only "can this page still reach the network", and a plain
                   cross-origin fetch answers the wrong one: Plex sends no CORS headers for a
                   tokenless endpoint, so a perfectly healthy request rejects. That reported
                   fetchOk=false on every single tick and would have been misread as the Android
                   network-suspension failure. A no-cors request yields an opaque response, whose
                   .ok is false and .status is 0 even on success - so resolving at all is the
                   signal, and only a genuine network failure rejects. */
                await fetch(`${probeOrigin}/identity`, { cache: "no-store", mode: "no-cors" });
                fetchOk = true;
            } catch {
                fetchOk = false;
            }
            fetchMs = Date.now() - startedAt;
        }
        /* Parked on window as well as posted, for the same reason reportStreamUrl does it: if the
           outbound postMessage channel is dead, native can still pull this via ExecuteScriptAsync
           and read S3 off the timestamp. `at` is what makes it answerable - a stale tick means JS
           stopped running, which is precisely the Android failure this is looking for. */
        window.__prismSpikeHeartbeat = JSON.stringify({ tick, at: Date.now(), fetchOk, fetchMs });
        post({ type: "spikeHeartbeat", tick, fetchOk, fetchMs });
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/* S1. Makes the page transparent so native video behind the WebView2 can show through at
   all, then draws markers that must remain visible ON TOP of it:
     - a full-viewport 2px outline, to see whether the WebView2 surface covers the frame
     - corner blocks, to catch the surface being offset or scaled
     - a translucent bar, to check alpha blending against video rather than just opacity
   If the video is visible and every marker draws over it, S1 passes. If the markers show
   but the video does not, WebView2 transparency is not working on this platform and the
   whole chrome-reuse plan needs revisiting. */
function showTestOverlay() {
    if (overlayEl) return;
    const html = document.documentElement;
    savedBackgrounds = { html: html.style.background, body: document.body.style.background };
    html.style.background = "transparent";
    document.body.style.background = "transparent";

    /* Transparent html/body is NOT sufficient on its own, and getting this wrong would have
       made S1 unanswerable: the app's own content is opaque, and during playback the web
       player's <video> is position:fixed inset:0 with background:#000, so it covers the entire
       frame regardless of what the page background is set to. Every existing body child is
       hidden here (the card, the modals, the player overlay and its chrome all live directly
       under <body>) so the only thing left painting is this overlay - which makes "no video
       visible" mean transparency genuinely failed, rather than "something was still covering
       it". Inline display values are saved so hideTestOverlay can put them back exactly. */
    savedBackgrounds.hidden = Array.from(document.body.children).map((el) => {
        const previous = el.style.display;
        el.style.display = "none";
        return { el, previous };
    });

    overlayEl = document.createElement("div");
    overlayEl.id = "prism-xbox-spike-overlay";
    overlayEl.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "pointer-events:none",
        "outline:2px solid #00ff88",
        "outline-offset:-2px",
        "font-family:monospace",
    ].join(";");
    overlayEl.innerHTML = `
        <div style="position:absolute;top:0;left:0;width:80px;height:80px;background:#ff0055"></div>
        <div style="position:absolute;top:0;right:0;width:80px;height:80px;background:#00ff88"></div>
        <div style="position:absolute;bottom:0;left:0;width:80px;height:80px;background:#0088ff"></div>
        <div style="position:absolute;bottom:0;right:0;width:80px;height:80px;background:#ffcc00"></div>
        <div style="position:absolute;left:0;right:0;top:45%;background:rgba(0,0,0,0.45);
                    color:#fff;font-size:28px;text-align:center;padding:18px">
            S1: native video should be visible behind this translucent bar
        </div>`;
    document.body.appendChild(overlayEl);
}

function hideTestOverlay() {
    if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
    }
    if (savedBackgrounds) {
        document.documentElement.style.background = savedBackgrounds.html;
        document.body.style.background = savedBackgrounds.body;
        (savedBackgrounds.hidden || []).forEach(({ el, previous }) => {
            el.style.display = previous;
        });
        savedBackgrounds = null;
    }
}

/* Registered at boot so native-initiated spike messages (the gamepad-driven start/stop)
   have somewhere to land. Registering the listener is free on every platform; the guard
   above means it never attaches off the Xbox shell. */
export function initXboxSpike() {
    const wv = bridge();
    if (!wv) return;
    wv.addEventListener("message", (event) => {
        let msg = event.data;
        if (typeof msg === "string") {
            try {
                msg = JSON.parse(msg);
            } catch {
                return;
            }
        }
        switch (msg?.type) {
            case "spikePlaybackStarted":
                showTestOverlay();
                startHeartbeat();
                break;
            case "spikePlaybackStopped":
                stopHeartbeat();
                hideTestOverlay();
                break;
            default:
                break;
        }
    });
    post({ type: "spikeReady" });
    console.log("[xbox-spike] harness ready");
}
