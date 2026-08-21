import { Capacitor, registerPlugin } from "@capacitor/core";

/* The one place that answers "which player backend is this build talking to". Before this
   existed, `Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"` was
   copy-pasted at ten call sites across plex-player.js and src/player/ui/, which is exactly
   the shape that produces a third divergent code path the moment a second native platform
   (the Xbox WebView2 shell) gets its own bridge. Everything that used to test that
   expression inline now calls hasNativePlayer()/platformTag() instead.

   @capacitor/core is a bundled npm import, not a native-injected global, so `Capacitor`
   and `window.Capacitor` are defined even in a plain PWA or inside WebView2 - it just
   resolves to platform "web" there, since WebView2 injects neither `androidBridge` nor
   `webkit.messageHandlers.bridge`. That's why Xbox needs its own marker rather than
   anything Capacitor can tell us. */

/* Set by the UWP shell via CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync, so it's
   present before any app script evaluates. Deliberately a private marker rather than
   window.CapacitorCustomPlatform: setting that would flip Capacitor.isNativePlatform() to
   true app-wide, silently changing branches that only ever meant "Android". */
const XBOX_MARKER = "__prismXboxNativePlayer";

/* "android" | "xbox" | "web" (or a raw Capacitor platform id for anything else).

   This is platform IDENTITY only - deliberately separate from hasNativePlayer() below.
   Identity is what Plex-facing decisions key off (which client capabilities to advertise,
   what X-Plex-Platform to send), and those are useful on Xbox well before Xbox has a native
   player. Deriving playback routing from identity instead would mean the first thing that
   wants to identify as Xbox silently breaks playback. */
export function platformTag() {
    if (typeof window !== "undefined" && window[XBOX_MARKER]) return "xbox";
    return Capacitor.getPlatform();
}

/* Set by the UWP shell alongside XBOX_MARKER above, but only on the PC target - MainPage.xaml.cs's
   DeviceFamily check. PC still reports platformTag() === "xbox" (same native player bridge,
   progressive-stream routing, and HDR/decode-capability story - the whole reason this app runs
   inside the UWP shell on PC instead of a plain browser), so this is deliberately a second,
   narrower signal rather than a change to platformTag() itself. */
const PC_SHELL_MARKER = "__prismPcShell";

/* Whether the player chrome should use Xbox's gamepad-only layout (floating center play button,
   no spacebar handler, no mouse-hover row) instead of web's mouse/hover one. NOT the same
   question as platformTag() === "xbox": PC is also tagged "xbox" for every streaming/native-
   player purpose above, but has a real mouse and wants the ordinary web layout - see
   PC_SHELL_MARKER. Scope this to UI-layout gates only (player-chrome.js, chrome-transport.js,
   chrome-menu.js); anything about streaming, native playback, or HDR should keep testing
   platformTag() === "xbox" directly. */
export function usesGamepadChrome() {
    return platformTag() === "xbox" && !(typeof window !== "undefined" && window[PC_SHELL_MARKER]);
}

/* Mirrored onto documentElement (same self-registering-on-import pattern as input-mode.js's
   own [data-input-mode]) so CSS elsewhere can key off [data-platform="xbox"] directly rather
   than every consumer needing its own JS-side platformTag() check. Exists specifically
   because input-mode.js's own UA/`pointer: none`-based isRemoteDrivenDevice() guess turned
   out not to reliably catch Xbox's real WebView2 UA/pointer capabilities on hardware - this
   marker is script-injected by the UWP shell itself (see XBOX_MARKER above), not sniffed,
   so it doesn't have that problem. Guarded on `document` existing since this module is also
   imported by plain-Node vitest specs, which have no DOM. */
if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = platformTag();
}

/* The platforms whose native playback bridge actually exists and is wired up. Add "xbox"
   here - and only here - when its bridge lands; nothing else needs to change.

   Kept as an explicit list rather than derived from platformTag() because "this platform is
   Xbox" and "this build can hand playback to a native player" are genuinely different facts.
   Conflating them is a trap: the Phase 0 spike build is a real case of a shell that has a
   partial native player and legitimately wants to be identified as Xbox, while playback still
   has to go through the <video>+hls.js path. If identity implied routing, that build would
   dispatch to native-bridge.js's Capacitor "NativePlayer" plugin, which does not exist on
   Xbox, and every play() would fail with "not implemented on web". */
const PLATFORMS_WITH_NATIVE_PLAYER = ["android", "xbox"];

/* True when a native playback bridge is present and should be used instead of the
   <video>+hls.js fallback in web-fallback.js. */
export function hasNativePlayer() {
    return PLATFORMS_WITH_NATIVE_PLAYER.includes(platformTag());
}

/* X-Plex-Platform for the transcode/decision URLs (see core/stream-url.js).

   This used to be `Capacitor.isNativePlatform() ? "Android" : "Chrome"` inline in
   plex-player.js's _buildStreamUrl/_buildDecisionUrl - note it tested only
   isNativePlatform(), not the OS, so ANY future native platform would have started
   claiming to be Android to Plex's Media Decision Engine. Keyed off the real tag now.

   Xbox deliberately still reports "Chrome": X-Plex-Platform is one of the inputs Plex
   picks a server-side client profile from, and a profile chosen for a real Xbox client
   could override the explicit X-Plex-Client-Capabilities this codebase sends. Changing it
   belongs with the HEVC/HDR capability work, where the two can be verified together
   against a real server, not as a side effect of this refactor. */
export function plexPlatformTag() {
    return platformTag() === "android" ? "Android" : "Chrome";
}

/* Whether this platform should ask Plex for progressive output (protocol=http, start.mp4) instead of
   HLS. Xbox must: HLS is measurably broken there, for two independent reasons documented in
   core/stream-url.js and docs/xbox-native-hdr-player/05-phase0-spike-results.md. Everything else
   keeps using HLS, which hls.js and ExoPlayer both handle well.

   Note this is keyed off platform IDENTITY, not hasNativePlayer() - the transport Plex is asked for
   and whether a native player exists are separate questions. */
export function usesProgressiveStream() {
    return platformTag() === "xbox";
}

/* Whether this platform can actually put HDR on screen, which is what decides whether HDR is
   advertised to Plex at all (see core/stream-url.js's clientCapabilities).

   Xbox only. Its native MediaFoundation pipeline passes HDR10 through and the console's HDMI output
   can be switched to it - documented by Microsoft and confirmed on hardware. The other legs cannot:
   a browser has no way to present HDR or even read a <video>'s colour space without WebCodecs, and
   Android's leg deliberately scopes HDR to "skip the SDR shader passes on HDR content" rather than
   real passthrough.

   Claiming HDR support from a player that cannot present it is worse than not claiming it: Plex would
   stop tone-mapping and hand over PQ frames to be displayed as washed-out SDR. */
export function supportsHdr() {
    return platformTag() === "xbox";
}

/* What this device can actually decode, beyond the conservative h264-1080p floor every leg
   advertises today (see core/stream-url.js's clientCapabilities). Cached after the first probe -
   decode hardware doesn't change mid-session - and defaulting to today's exact conservative
   behavior (false) until primeDecodeCapabilities() resolves, so a play() that somehow races the
   probe just gets the same h264-only treatment as before this existed, never a false positive. */
let _decodeCaps = { hevcMain10_2160: false };

/* Call once at boot (see app.js), fire-and-forget - by the time a user reaches a title's Play
   button (after sign-in, browsing, picking something), this has virtually always resolved.
   Swallows every failure into the conservative default rather than throwing, since a capability
   probe should never be able to block or break playback. */
export async function primeDecodeCapabilities() {
    const tag = platformTag();
    if (tag === "xbox") {
        /* Static hardware fact, not a probe - every Xbox console this ships to (One S and later,
           the only device family Xbox UWP apps target) has a hardware HEVC Main10 decoder. Same
           "whole device family" reasoning supportsHdr() above already relies on. */
        _decodeCaps = { hevcMain10_2160: true };
        return;
    }
    if (tag === "android") {
        try {
            /* A fresh registerPlugin("NativePlayer") call, not an import from native-bridge.js -
               that file already documents one real circular-import failure of its own (see its
               NATIVE_TIMELINE_PING_MS comment) from importing back the other way. registerPlugin
               returns the same underlying plugin proxy regardless of how many call sites request
               it, so this is safe and keeps platform.js's own module graph simple. */
            const caps = await registerPlugin("NativePlayer").getDecodeCapabilities();
            _decodeCaps = { hevcMain10_2160: !!caps?.hevcMain10_2160 };
        } catch {
            /* Leave the conservative default. */
        }
        return;
    }
    try {
        if (typeof navigator !== "undefined" && navigator.mediaCapabilities) {
            /* Codec string unverified against a real Chrome/Edge build - decodingInfo() is picky
               about the exact fourCC/profile/level and a wrong string just silently reports
               unsupported (safe: falls back to today's h264-only behavior), not an error. Verify
               this isn't ALWAYS falling back before trusting a `true` result here matters. */
            const result = await navigator.mediaCapabilities.decodingInfo({
                type: "file",
                video: {
                    contentType: 'video/mp4; codecs="hvc1.2.4.L153.90"',
                    width: 3840,
                    height: 2160,
                    bitrate: 20_000_000,
                    framerate: 24,
                },
            });
            _decodeCaps = { hevcMain10_2160: !!result?.supported };
        }
    } catch {
        /* Leave the conservative default. */
    }
}

export function getDecodeCapabilities() {
    return _decodeCaps;
}
