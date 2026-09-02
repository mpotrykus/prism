import { Capacitor, registerPlugin } from "@capacitor/core";

/* Which platform this build is, and what that implies for playback. Identity and routing are
   deliberately separate questions throughout this file - see platformTag/hasNativePlayer.

   @capacitor/core is a bundled npm import, not a native-injected global, so `Capacitor` is
   defined even in a plain PWA or inside WebView2 - it just resolves to platform "web" there,
   since WebView2 injects neither `androidBridge` nor `webkit.messageHandlers.bridge`. That's
   why the UWP shell needs its own marker rather than anything Capacitor can tell us. */

/* Anything else Capacitor.getPlatform() might report (e.g. "ios") has no constant here, since
   nothing in this codebase branches on it. */
export const PLATFORM_TAG = Object.freeze({
    ANDROID: "android",
    UWP: "uwp",
    WEB: "web",
});

/* Set by the UWP shell via CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync, so it's
   present before any app script evaluates. Deliberately a private marker rather than
   window.CapacitorCustomPlatform: setting that would flip Capacitor.isNativePlatform() to true
   app-wide, silently changing branches that only ever meant "Android". */
const UWP_MARKER = "__prismUwpNativePlayer";

/* "uwp" covers both real Xbox consoles and the PC target - both run inside the same
   UWP+WebView2 shell and share its native-player/streaming/HDR routing; PC_SHELL_MARKER below
   is the narrower signal for the few places that need to tell the two apart.

   This is platform IDENTITY only, deliberately separate from hasNativePlayer() below. Identity
   is what Plex-facing decisions key off (which client capabilities to advertise, what
   X-Plex-Platform to send), and those are useful on the UWP shell well before it has a native
   player. Deriving playback routing from identity instead would mean the first thing that wants
   to identify as UWP silently breaks playback. */
export function platformTag() {
    if (typeof window !== "undefined" && window[UWP_MARKER]) return PLATFORM_TAG.UWP;
    return Capacitor.getPlatform();
}

/* Set alongside UWP_MARKER, but only on the PC target - see MainPage.xaml.cs's DeviceFamily
   check. PC still reports platformTag() === "uwp" (same native player bridge, progressive-stream
   routing and HDR/decode story - the whole reason this app runs inside the UWP shell on PC
   rather than a plain browser), so this is a second, narrower signal, not a change to
   platformTag() itself. */
const PC_SHELL_MARKER = "__prismPcShell";

/* Whether the player chrome should use Xbox's gamepad-only layout (floating center play button,
   no spacebar handler, no mouse-hover row) instead of web's. NOT the same question as
   platformTag() === "uwp": PC is also tagged "uwp" for every streaming purpose but has a real
   mouse and wants the web layout. Scope this to UI-layout gates only; anything about streaming,
   native playback or HDR should test platformTag() directly. */
export function usesGamepadChrome() {
    return isXboxDevice();
}

/* True only on a real Xbox console, never PC. Same construction as usesGamepadChrome(), exported
   separately because that one's scope is explicitly limited to player-chrome layout - this is
   for other Xbox-only-vs-PC checks, e.g. the Always-on HDR toggle in Settings. */
export function isXboxDevice() {
    return platformTag() === PLATFORM_TAG.UWP && !(typeof window !== "undefined" && window[PC_SHELL_MARKER]);
}

/* Mirrored onto documentElement so CSS can key off [data-platform]/[data-xbox-device] directly.
   Needed because input-mode.js's UA/`pointer: none` heuristic turned out not to reliably catch
   Xbox's real WebView2 capabilities on hardware - this marker is script-injected by the shell
   itself, not sniffed. Guarded on `document` since vitest specs import this module with no DOM. */
if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = platformTag();
    document.documentElement.dataset.xboxDevice = String(isXboxDevice());
}

/* The platforms whose native playback bridge actually exists and is wired up.

   An explicit list rather than something derived from platformTag(), because "this platform is
   UWP" and "this build can hand playback to a native player" are genuinely different facts. The
   Phase 0 spike build was a real case of a shell with a partial native player that legitimately
   wanted to be identified as UWP while playback still went through <video>+hls.js. Had identity
   implied routing, every play() there would have dispatched to native-bridge.js's Capacitor
   plugin - which doesn't exist on that shell - and failed with "not implemented on web". */
const PLATFORMS_WITH_NATIVE_PLAYER = [PLATFORM_TAG.ANDROID, PLATFORM_TAG.UWP];

export function hasNativePlayer() {
    return PLATFORMS_WITH_NATIVE_PLAYER.includes(platformTag());
}

/* X-Plex-Platform for the transcode/decision URLs (see core/stream-url.js).

   Xbox deliberately reports "Chrome": X-Plex-Platform is one of the inputs Plex picks a
   server-side client profile from, and a profile chosen for a real Xbox client could override the
   explicit X-Plex-Client-Capabilities this codebase sends. Changing it belongs with the HEVC/HDR
   capability work, where the two can be verified together against a real server. */
export function plexPlatformTag() {
    return platformTag() === PLATFORM_TAG.ANDROID ? "Android" : "Chrome";
}

/* Whether to ask Plex for progressive output (protocol=http, start.mp4) instead of HLS. Xbox must:
   HLS is measurably broken there for two independent reasons, documented in core/stream-url.js and
   docs/xbox-native-hdr-player/05-phase0-spike-results.md. Everything else keeps HLS, which hls.js
   and ExoPlayer both handle well. Keyed off identity, not hasNativePlayer(). */
export function usesProgressiveStream() {
    return platformTag() === PLATFORM_TAG.UWP;
}

/* Whether this platform can actually put HDR on screen, which is what decides whether HDR is
   advertised to Plex at all (see core/stream-url.js's clientCapabilities).

   Xbox only. Its native MediaFoundation pipeline passes HDR10 through and the console's HDMI
   output can be switched to it - documented by Microsoft, confirmed on hardware. The others
   cannot: a browser has no way to present HDR or even read a <video>'s colour space without
   WebCodecs, and Android's leg scopes HDR to "skip the SDR shader passes on HDR content" rather
   than real passthrough.

   Claiming HDR from a player that can't present it is worse than not claiming it: Plex would stop
   tone-mapping and hand over PQ frames to be displayed as washed-out SDR. */
export function supportsHdr() {
    return platformTag() === PLATFORM_TAG.UWP;
}

/* What this device can decode beyond the conservative h264-1080p floor every leg advertises (see
   core/stream-url.js's clientCapabilities). Cached after the first probe - decode hardware doesn't
   change mid-session - and false until primeDecodeCapabilities() resolves, so a play() that races
   the probe gets h264-only treatment rather than a false positive. */
let _decodeCaps = { hevcMain10_2160: false };

/* Call once at boot, fire-and-forget: by the time a user reaches a title's Play button this has
   virtually always resolved. Swallows every failure into the conservative default - a capability
   probe should never be able to block or break playback. */
export async function primeDecodeCapabilities() {
    const tag = platformTag();
    if (tag === PLATFORM_TAG.UWP) {
        /* A static hardware fact, not a probe: every Xbox console this ships to (One S and later,
           the only device family Xbox UWP apps target) has a hardware HEVC Main10 decoder. */
        _decodeCaps = { hevcMain10_2160: true };
        return;
    }
    if (tag === PLATFORM_TAG.ANDROID) {
        try {
            /* A fresh registerPlugin call rather than importing from native-bridge.js, which has
               already hit one real circular-import failure of its own (see its
               NATIVE_TIMELINE_PING_MS comment). registerPlugin returns the same underlying proxy
               however many call sites request it. */
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
               about the exact fourCC/profile/level, and a wrong string silently reports
               unsupported (safe: falls back to h264-only) rather than erroring. Confirm this isn't
               ALWAYS falling back before trusting a `true` result. */
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
