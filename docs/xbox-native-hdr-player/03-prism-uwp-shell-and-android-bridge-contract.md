# Xbox Native Player Bridge — Technical Briefing

## 1. `plex-player.js` structure and JS-side playback contract

**File:** `plex-player.js` (640 lines), with sub-modules in `src\player\`.

**Native detection** — every branch point checks both platform and OS, not just "is native":
```js
Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
```
Used at: `plex-player.js:202` (`_switchTitle`), `:229` (`_beginSession`), `:392` (`_teardownMedia`), `:605`/`:614` (`pause`/`resume`). There is no generic "has native player" flag — an Xbox path must add its own `Capacitor.getPlatform() === "..."` (or equivalent UWP/WebView2 detection) branch at each of these four call sites, or `_teardownMedia`/`_beginSession`/`_switchTitle`/`pause`/`resume` will silently fall through to the `<video>`+hls.js path. Also used in `_buildStreamUrl` (`plex-player.js:421-427`) to set `X-Plex-Platform` (`"Android"` vs `"Chrome"`) on the transcode URL — an Xbox path would need its own platform string here.

**Controller/session state** lives on `StreamingPlayerController` (`plex-player.js:84-640`), one singleton instance exported as `player` (`plex-player.js:640`). Key session fields built in `_prepareSession` (`plex-player.js:256-366`): `ratingKey`, `key`, `plexUrl`, `plexToken`, `transcodeSessionId`, `durationMs`, `lastTimeMs`, `state`, `markers`, `chapters`, `bifIndexPath`, `title`/`episodeTitle`/`year`/`seasonNumber`/`episodeNumber`, `mediaIndex`, `qualityCapKbps`, `mediaVersions`, `audioStreams`, `audioStreamId`, `partId`, `queueRatingKeys`, `queueIndex`.

**Playback lifecycle entry points** (all delegate to platform-specific modules, `plex-player.js:441-463`):
- `play(item)` → `_beginSession` → native: `_playNative` (delegates to `native-bridge.js:playNative`); web: `_playWeb` (delegates to `web-fallback.js:playWeb`)
- `_switchTitle(item)` (adjacent-title nav) → native: `_switchTitleNative` → `native-bridge.js:switchNative`; web: teardown+`_beginSession` again
- `stop()`/`_teardownMedia()` → native: `native-bridge.js:stopNative`; web: `web-fallback.js:teardownWeb`
- `pause()`/`resume()` → native: `native-bridge.js:pauseNative`/`resumeNative`; web: `videoEl.pause()`/`.play()`

**Native bridge call surface** (`src\player\native-bridge.js`), via `registerPlugin("NativePlayer")` (line 8):
- `NativePlayer.play(payload)` (line 206) — cold start, launches a new native Activity/window
- `NativePlayer.switchTitle(payload)` (line 298, `switchNative`) — in-place title swap, no new native surface
- `NativePlayer.pause()` / `.resume()` (lines 312/316)
- `NativePlayer.stop()` (line 305)
- `NativePlayer.setPlaybackSpeed({ speed })` (line 320)
- `NativePlayer.setSubtitle({ text, languageCode, mimeType })` (line 324) — raw `.srt` **text**, not a URL
- `NativePlayer.setSubtitleOffset({ offsetMs })` (line 342) — absolute value, not delta
- `NativePlayer.notifySubtitleApplied({ fileId, label })` (line 333) — used for auto-reapply too, not just manual pick
- `NativePlayer.showSkipButton({ label, seekToMs })` / `.hideSkipButton()` (native-bridge.js:77-79, only invoked from inside the "progress" listener)
- `NativePlayer.showEpisodeList({ items })` (line 130) — JS pre-resolves Plex metadata, hands native a pre-formatted array; native just renders
- `NativePlayer.showSubtitleResults({ items, error })` (line 152/156) — same "JS resolves protocol, native renders" split

**The `payload` shape** sent to `play`/`switchTitle` is built once by `buildPlaybackPayload(controller, streamUrl, startOffsetMs)` (`native-bridge.js:213-288`) and reused for both calls so they never drift:
```
{ url, startPositionMs, shaderType,
  chapters: [{title, startTimeOffsetMs, thumbUrl}],
  bifUrl,
  audioStreams: [{id: String, label, selected}],
  partId: String|null,
  mediaVersions: [{mediaIndex, label}],
  currentMediaIndex, qualityCapKbps,
  title, episodeTitle, year, seasonNumber, episodeNumber,
  queueLength, queueIndex }
```
Everything numeric-but-Plex-opaque (`partId`, `audioStreams[].id`) is explicitly `String(...)`-coerced on the JS side before crossing the bridge (line 244-261) — this is the fix for the documented "audio track switch reaches Android as null" bug (see section 4).

**Events JS listens for from native** (`native-bridge.js:26-205`, all registered once in `playNative`, kept alive across in-place title switches):
- `"progress"` → `{ positionMs, durationMs }` — the *only* per-tick channel; JS updates `session.lastTimeMs`/`durationMs`, piggybacks the throttled `/:/timeline` ping here (see below), checks skip-marker state, and does the one-time "apply remembered subtitle" check keyed by `ratingKey`
- `"ended"` → no payload → `controller.stop()`
- `"error"` → `{ message }` → `controller.stop()`
- `"stopped"` → no payload → `controller.stop()`
- `"titleNav"` → `{ index }` → `playQueuedTitle(controller, queue, index)`
- `"episodeListRequested"` → no payload → JS fetches queue via `getQueueItems`/`formatEpisodeListItem`, replies via `NativePlayer.showEpisodeList`
- `"subtitleSearchRequested"` → `{ query }` → JS calls `plex-subtitles.js`'s `search()`, replies via `showSubtitleResults`
- `"subtitleSelectRequested"` → `{ fileId, label, languageCode }` → JS downloads via `plex-subtitles.js`'s `download()`, calls `setNativeSubtitle`, then `notifySubtitleApplied`/`notifySubtitleApplyFailed`
- `"subtitleCleared"` → no payload → JS forgets the remembered per-title subtitle
- `"subtitleOffsetChanged"` → `{ offsetMs }` → JS persists it (`subtitle-store.js`)

**Plex `/:/timeline` progress-reporting loop** lives entirely in `plex-player.js`, not native, per the project's stated architecture. `_reportTimeline(state)` (`plex-player.js:621-637`) builds:
```
GET {plexUrl}/:/timeline?ratingKey&key&state&time&duration&X-Plex-Client-Identifier&X-Plex-Token
```
It needs from the session only `ratingKey`, `key`, `lastTimeMs`, `durationMs`, `plexToken` — i.e., from native it needs nothing but raw position/duration (confirmed by the "progress" event payload above containing only `positionMs`/`durationMs`). Two drivers exist:
1. `_pingTimer` (`setInterval`, `TIMELINE_PING_MS = 10000`, `plex-player.js:72`) — set up in `_beginSession`/`_switchTitleNative`, but **does not fire during Android native playback** because Capacitor's `BridgeActivity` WebView is paused (`WebView.onPause()` freezes JS timers) whenever `PlayerActivity` is foregrounded (documented at `native-bridge.js:31-59`).
2. A piggyback ping inside the native `"progress"` listener (`native-bridge.js:55-59`), throttled via `controller._lastNativeTimelinePingAt` against the same `NATIVE_TIMELINE_PING_MS = 10000` constant — this is the *only* channel that actually reaches Plex during native playback, because native explicitly calls into the WebView's JS engine (bypassing the WebView-paused timer freeze). **Any Xbox native player must deliver a "progress" (or equivalent) tick to JS via an active push (not rely on a JS-side interval) if the WebView2/JS runtime is similarly suspended while the native player is foregrounded** — otherwise Plex never gets `/:/timeline` pings and the Media Decision Engine won't durably track the session. Whether WebView2 on Xbox actually suspends JS execution the same way Android's WebView does is unverified — worth checking empirically before assuming this gotcha transfers directly (see `04-relevant-lessons-from-memory.md`).

**Fallback `<video>`+hls.js path** (`src\player\web-fallback.js`) — the surface a native Xbox implementation should be equivalent to:
- `playWeb(controller, streamUrl, startOffsetMs)` (line 84) creates a full-screen `<video>` overlay, wires `timeupdate`/`ended`/`pause`/`play`/`error`/`click` handlers, builds the transport chrome, and starts the ABR loop.
- `attachSource(controller, video, streamUrl)` (line 163) branches: real hls.js instance (most browsers, including presumably Xbox's WebView2, since WebView2 has no native HLS — noted in CLAUDE.md) vs. native `<video src>` (Safari only). hls.js wiring includes `Hls.Events.ERROR` (fatal → stop, non-fatal `BUFFER_STALLED_ERROR` → `notifyStall`) and `Hls.Events.FRAG_LOADED` (flips `_abrHasRealSample`).
- `trySwitchAudioTrackLocal(controller, audioStreamID)` (line 235) — pure client-side `hls.audioTrack = index` switch, no new transcode session, gated on `hls.audioTracks.length === streams.length`.
- `reloadWebSource(controller, overrides)` (line 268) — the session-restart path for mediaIndex/qualityCap/fallback-audio switches: builds a new session id, PUTs the Part's selected audio stream if switching audio, explicitly stops the old transcode session, calls `/decision` first, then rebuilds the `<video>`/hls.js source and calls `notifyReload`/`updateAbrMonitor`.
- `teardownWeb(controller)` (line 358) tears down hls.js, shader/ambient/stats pipelines, all menu overlays, subtitle track/blob URL, and the `<video>` element itself.
- Chapters/BIF scrub-preview: `controller._session.chapters`/`.bifIndexPath` feed `src\player\core\bif.js` (web) and `BifIndex.java` (native) independently — each platform parses/fetches the BIF trickplay index itself from the same tokened URL.

## 2. Android `NativePlayerPlugin` and `PlayerActivity`

**Files:**
- `android\app\src\main\java\com\mpotrykus\streaming\NativePlayerPlugin.java` (368 lines)
- `android\app\src\main\java\com\mpotrykus\streaming\PlayerActivity.java` (2631 lines)
- `android\app\src\main\java\com\mpotrykus\streaming\QualityAbrMonitor.java` (188 lines)

**`@PluginMethod` list** (`NativePlayerPlugin.java`): `play` (line 72), `switchTitle` (line 127), `pause` (144), `resume` (150), `seek` (156), `stop` (167), `setPlaybackSpeed` (173), `showSkipButton` (184), `hideSkipButton` (196), `showEpisodeList` (207), `setSubtitle` (217), `setSubtitleOffset` (236), `showSubtitleResults` (252), `notifySubtitleApplied` (264), `notifySubtitleApplyFailed` (272).

`play` (line 73) parses params via a shared `parsePlaybackParams(PluginCall)` (line 45) into a `PlaybackParams` struct, builds an `Intent` to `PlayerActivity` with one `EXTRA_*` per field, and launches via `startActivityForResult(call, intent, "onPlaybackActivityResult")` (line 109) — a genuinely new Activity/window. `switchTitle` (line 127) instead calls the static `PlayerActivity.loadTitle(...)` directly (no Intent), so the running Activity/ExoPlayer instance is reused in place — this is why title-prev/next don't visibly relaunch a window.

**`notifyListeners` calls back to JS** (all in `NativePlayerPlugin.java`, implementing `PlayerActivity.PlaybackListener`): `onProgress→"progress"{positionMs,durationMs}` (281), `onEnded→"ended"{}` (289), `onError→"error"{message}` (294), `onStopped→"stopped"{positionMs}` (301), `onTitleNavRequested→"titleNav"{index}` (308), `onEpisodeListRequested→"episodeListRequested"{}` (320), `onSubtitleSearchRequested→"subtitleSearchRequested"{query}` (329), `onSubtitleSelectRequested→"subtitleSelectRequested"{fileId,label,languageCode}` (339), `onSubtitleCleared→"subtitleCleared"{}` (353), `onSubtitleOffsetChanged→"subtitleOffsetChanged"{offsetMs}` (362).

**`PlayerActivity` ExoPlayer setup** — `createPlayer()` (`PlayerActivity.java:746-866`): builds a fresh `ExoPlayer` per title/reload (documented real-device gotcha: reusing one instance across a title switch left ExoPlayer wedged in `STATE_BUFFERING` forever, line 733-745), with a `DefaultMediaSourceFactory` wrapping `DefaultDataSource.Factory` around a `DefaultHttpDataSource.Factory` (necessary so the Sync +/- control's `file://` sidecar subtitle loads — a bare HTTP factory silently failed on local files, line 751-767). An `AnalyticsListener.onLoadCompleted` feeds `QualityAbrMonitor.onSegmentLoadCompleted(bytesLoaded, loadDurationMs)` (line 780-787) since ExoPlayer's own `DefaultBandwidthMeter` never gets fed by this bare HTTP factory. A `Player.Listener` (788-865) drives loading-spinner visibility, ABR stall notification (`STATE_BUFFERING` + `everStartedPlaying` guard), `STATE_ENDED` → either `requestTitleNav` (native auto-play-next, decided *before* `finish()`, unlike the web leg which reacts after the fact) or `listener.onEnded()`+`finish()`, `onPlayerError` → `notifyErrorAndFinish`, and `onTracksChanged` → re-runs `applyVideoEffects()` once real track `Format`/`colorInfo` is known.

**HDR handling** (`isHdrContent()`, `PlayerActivity.java:1165-1172`):
```java
boolean isHdrContent() {
    Format format = selectedVideoFormat();
    ColorInfo colorInfo = format != null ? format.colorInfo : null;
    if (colorInfo == null) return false;
    return colorInfo.colorSpace == C.COLOR_SPACE_BT2020
        || colorInfo.colorTransfer == C.COLOR_TRANSFER_ST2084
        || colorInfo.colorTransfer == C.COLOR_TRANSFER_HLG;
}
```
This is used *only* to auto-skip the GL shader/color-boost effects pass (`applyVideoEffects()`, lines 1065-1104) on HDR sources — explicitly documented (lines 1135-1148) as **not** full HDR passthrough: no Dolby Vision profile handling, no display HDR-mode switching. There is no `VideoFrameMetadataListener` or `TrackSelectionParameters`-based HDR output-mode selection anywhere in this file — HDR support on Android is scoped to "don't apply SDR-tuned shaders to HDR content," nothing more. `selectedVideoFormat()`/`selectedAudioFormat()` (lines 1111-1133) walk `player.getCurrentTracks().getGroups()` for the currently-selected `Format`, shared by `isHdrContent()`, `resolveScaleFactor()`, `pipAspectRatio()`, and the stats overlay.

**Token-in-URL auth confirmed**: no custom HTTP header injection exists anywhere in `PlayerActivity.java`/`NativePlayerPlugin.java` — every Plex URL (`currentUrl`, PUT/GET calls in `switchAudioStreamViaRestart`, `askDecision`, etc.) carries `X-Plex-Token` as a query parameter, consistent with the CLAUDE.md invariant.

**WebView-paused-during-playback lifecycle quirk**: documented at `native-bridge.js:31-59` (see section 1) — the native "progress" bridge call is delivered by Java directly invoking WebView script execution, which survives `WebView.onPause()`; JS-side `setInterval`/`setTimeout` (the `_pingTimer`) do not run at all while `PlayerActivity` is foregrounded.

## 3. `uwp/PrismUwp/` shell — current state

**Directory contents** (excluding `.vs/`, `obj/`, `bin/`, `AppPackages/`): `App.xaml`/`App.xaml.cs`, `MainPage.xaml`/`MainPage.xaml.cs`, `Package.appxmanifest`, `PrismUwp.csproj`/`.csproj.user`/`.sln`, `PrismUwp_TemporaryKey.pfx`/`.cer`, `Properties\AssemblyInfo.cs`/`Default.rd.xml`, `Assets\*` (logos/splash), `www\` (synced build output: `index.html`, `assets/*.js`, `manifest.webmanifest`, `sw.js`).

**`App.xaml.cs`**: standard UWP `Application` subclass. Notable: sets `RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested` (line 23, hides virtual mouse cursor for gamepad-driven UI); sets `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` env vars before `EnsureCoreWebView2Async()` (lines 27-39, remote-debugging is the only way to inspect JS state on real Xbox hardware, no local F12). No native player bridge code here.

**`MainPage.xaml.cs`**: "Shell-only page" per its own header comment (line 14-20) — explicitly states no native player bridge exists yet. `InitializeWebViewAsync()` (lines 49-90):
- Constructs a `WebView2` control, calls `EnsureCoreWebView2Async()`, then adds it to the visual tree and focuses it (`this.Content = webView`, line 62-63 — must happen *after* `EnsureCoreWebView2Async`, WebView2 can't take focus before that).
- `coreWebView.SetVirtualHostNameToFolderMapping("prismuwp.local", "www", CoreWebView2HostResourceAccessKind.Allow)` (line 83-84) maps the local `www/` folder to `https://prismuwp.local/`, then navigates `webView.Source` to `https://prismuwp.local/index.html` (lines 31/89).
- Disables context menus, status bar, autofill, password autosave; leaves `AreDevToolsEnabled = true` (to be disabled before Store submission per an inline TODO, line 79-81).
- **No `AddHostObjectToScript`, no `WebMessageReceived` handler, no `postMessage`-based bridge of any kind exists.** The only JS↔native channel currently present is one-directional, native→JS, via `ExecuteScriptAsync` injecting synthetic `KeyboardEvent`s (see below) — there is nothing resembling a player-control bridge yet.
- `OnCoreWindowKeyDown` (lines 119-126) forwards Xbox gamepad D-pad/A/B (arriving as `CoreWindow.KeyDown` `VirtualKey.GamepadDPad*`/`GamepadLeftThumbstick*`/`GamepadA`/`GamepadB`) into synthetic `document.dispatchEvent(new KeyboardEvent('keydown', {key: ..., bubbles: true, composed: true}))` calls via `ExecuteScriptAsync`, mapped to `ArrowUp/Down/Left/Right`/`Enter`/`Escape` (`MapGamepadKey`, lines 128-151) — this feeds the existing `focus-nav.js` keyboard-based navigation, unrelated to playback.

**`Package.appxmanifest`**: `TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"` (line 41) — no `Windows.Xbox` family entry (deliberate, matches Microsoft's own WebView2-on-Xbox reference sample; a comment at lines 29-40 notes Xbox Dev Mode sideloads any `Windows.Universal` package directly). `Capabilities` block (lines 64-78) declares only `internetClient`; a comment explicitly flags **`hevcPlayback` / PlayReady `DeviceCapability` as not yet requested**, "Add ... once MediaPlayerElement/HLS native playback is implemented" — i.e., these capabilities will need to be added when the native player ships. No HDR-specific capability exists or is mentioned anywhere in the manifest.

**`PrismUwp.csproj`**: `TargetPlatformIdentifier=UAP`, `TargetPlatformVersion=10.0.26100.0`, `TargetPlatformMinVersion=10.0.19041.0` (lines 13-15). Package references: `Microsoft.NETCore.UniversalWindowsPlatform` 6.2.15, `Microsoft.UI.Xaml` 2.8.7, `Microsoft.Web.WebView2` 1.0.4129.50 (lines 106-114). A comment (lines 96-105) confirms no Xbox-specific extension SDK reference exists or is needed — Xbox targeting is expressed purely via the manifest's `TargetDeviceFamily`. Release builds set `UseDotNetNativeToolchain=true` (line 45); the project is C# (`.NET Native` framework dependency applies, per CLAUDE.md), not C++/WinRT.

## 4. Audio/quality/track-switching contract specifics (logical contract, transport-agnostic)

**The "audioStreamID reaches native as null" bug** (see `04-relevant-lessons-from-memory.md` for the full 5-bug saga): root cause was `Capacitor.PluginCall.getString("partId")` returning `null` for a JSON *number* (Plex's raw `Part.id`) crossing the Capacitor bridge — a type-mismatch that fails silently. Fix lives entirely on the JS send side: `native-bridge.js:261` explicitly does
```js
partId: controller._session.partId != null ? String(controller._session.partId) : null,
```
and `native-bridge.js:244` does the same for `audioStreams[].id`:
```js
audioStreams: (...).map((s) => ({ id: String(s.id), label: s.label || "Unknown", selected: !!s.selected })),
```
**Any Xbox bridge (WebView2 message-passing) must apply the same rule**: coerce any Plex-sourced numeric id (`partId`, audio stream `id`) to a string *before* serializing across the JS↔native boundary, since WebView2's `postMessage`/`ExecuteScriptAsync` JSON round-trip could have its own type-fidelity quirks worth verifying empirically rather than assuming JSON numbers survive intact.

**Logical method/event contract for audio-track switching** (platform-agnostic, from `native-bridge.js` + `PlayerActivity.java`):
- Local (no restart) path exists on both platforms when Plex's `directStreamAudio=1` (baked into every transcode URL, `stream-url.js:49`) has remuxed every embedded audio track into the running HLS session as its own rendition: Android's `switchAudioStreamLocally` (`PlayerActivity.java:2174-2200`) does a live `TrackSelectionParameters` override if `audioGroups.size() >= 2 && == audioStreams.size()`; the web leg's `trySwitchAudioTrackLocal` (`web-fallback.js:235-255`) does the hls.js equivalent (`hls.audioTrack = index`) under the same group-count-match guard. Both still fire a fire-and-forget `PUT /library/parts/<partId>?audioStreamID=...&allParts=1` to keep Plex's own "selected" bookkeeping in sync.
- Restart-based fallback (`switchAudioStreamViaRestart` in Java, `reloadWebSource` in JS) is needed when the local track-count check fails. The verified three-step sequence (confirmed against a real Plex server) is: (1) PUT the Part's `audioStreamID` selection, (2) `GET /video/:/transcode/universal/stop?session=<oldSessionId>` to kill the stale session immediately (a fresh session id alone is not sufficient — Plex kept serving the old session's audio otherwise), (3) `GET /video/:/transcode/universal/decision` with the *exact same query params* the new `/start.m3u8` URL will use (a bare `/start` alone kept transcoding the previous selection — this is the actual root fix), then finally rebuild the player source. `askDecision` on Android (`PlayerActivity.java:2369-2383`) does a plain string substring-replace rather than `Uri.Builder.path()`, because `path()` re-encodes the literal `:` in `/video/:/transcode/universal/decision` to `%3A`, silently 404ing — a gotcha any Xbox URL-building code must also avoid.
- Race protection: Android uses a `reloadGeneration` counter (bumped on every switch attempt, stale results discarded, `PlayerActivity.java:285-300`) plus `runSerializedReload`/`reloadInFlight`/`queuedReload` (lines 301-349) to ensure only one restart-reload is ever in flight against Plex at a time, coalescing rapid successive requests to the latest. Both mechanisms are documented as independently necessary against a real server (concurrent requests corrupted server-side transcode state even when the client discarded the "losing" response). Subtitle state (`currentSubtitleConfigOrNull()`, line 2138-2146) must be explicitly carried forward into every rebuilt `MediaItem` on any restart-reload — a plain rebuild silently drops the active subtitle otherwise (confirmed bug).
- Quality-cap/version switching (`switchMediaVersion`/`switchQualityCap`, `PlayerActivity.java:2394-2453`) reuse the identical "ask `/decision`, then rebuild in place at the resumed position" mechanism, keyed on `mediaIndex`/`maxVideoBitrate` params instead of `audioStreamID`.

**Bandwidth-based Auto-ABR — logical contract**, mirrored line-for-line between `src\player\core\abr.js` (web/hls.js) and `android\...\QualityAbrMonitor.java` (Android/ExoPlayer):
- Ladder: `QUALITY_CAP_PRESETS` (`src\player\ui\shared.js:8-14`) = `[Original(null), 1080p(20000kbps), 720p(10000), 480p(4000), 360p(2000)]`; `ORIGINAL_PROXY_KBPS = 20000` stands in for "Original"'s demand in threshold math.
- Constants (identical on both platforms): `TICK_INTERVAL_MS=5000`, `COOLDOWN_MS=20000`, `STABILITY_WINDOW_TICKS=6`, `DOWNGRADE_CONFIRM_TICKS=2`, `STEP_UP_HEADROOM_MULTIPLIER=1.5`, `STEP_DOWN_THRESHOLD_MULTIPLIER=0.9`.
- Bandwidth signal source differs by platform but the *contract* is "kbps of the most recently completed segment fetch, smoothed": web reads hls.js's `bandwidthEstimate` directly (`abr.js:103`); Android has no ExoPlayer-native bandwidth meter wired up, so it manually computes `bytesLoaded*8/loadDurationMs` off `AnalyticsListener.onLoadCompleted` (`PlayerActivity.java:780-787` feeding `QualityAbrMonitor.onSegmentLoadCompleted`, `QualityAbrMonitor.java:69-75`) and EWMA-smooths it (`BANDWIDTH_SMOOTHING_FACTOR=0.5`, Android-only — the web leg trusts hls.js's own smoothing).
- Decision function (`decideAbrAction` in JS / `evaluate()` in Java — logically identical): if bandwidth < currentRung*0.9 for `DOWNGRADE_CONFIRM_TICKS` consecutive ticks → jump to `bestDowngradeTarget` (best rung the bandwidth actually clears, not one step at a time); if bandwidth ≥ nextBetterRung*1.5 for `STABILITY_WINDOW_TICKS` consecutive ticks → step up one rung. All switches respect `COOLDOWN_MS` and reset `downgradeStreak`/`stableStreak`.
- `notifyStall()` (both platforms) bypasses the stability/confirm-tick gating entirely on a genuine rebuffer signal — web: hls.js `BUFFER_STALLED_ERROR`; Android: `Player.STATE_BUFFERING` after `everStartedPlaying` has gone true once (guards against cold-start/reload buffering being misread as a stall) — still respects `COOLDOWN_MS`.
- `notifyReload()` (both) resets the streak/cooldown bookkeeping on every reload (manual or auto), since a fresh transcode session has no relationship to the previous one's degradation history.
- The actual quality change always goes through the exact same restart mechanism as a manual Quality Cap pick (`reloadWebSource`/`switchQualityCap`) — ABR has no separate "seamless" switching path on either platform, because Plex's transcode endpoint returns one fixed-bitrate rendition per request, not a multi-variant manifest.
- Manual toggle persistence: `storedAutoQualityEnabled()`/`AUTO_QUALITY_STORAGE_KEY` (`shared.js:56,152-154`, defaults **off**, unlike Auto-Play which defaults on) on web/localStorage; Android mirrors via `PREF_AUTO_QUALITY_ENABLED` SharedPreferences default `true` (`PlayerActivity.java:141,271,498` — Android's default is intentionally different from web's off-default: "Auto Quality only ever reacts to real degradation... no downside to it running from a user's very first session").

**Manual Quality Cap / Version picker** — logical parameters an Xbox bridge needs to expose: `switchQualityCap(kbps: Integer|null)` and `switchMediaVersion(mediaIndex: int)`, both going through the identical decision-then-restart mechanism above; `qualityCapKbps=null` means "no cap / Original" and must be *omitted* from the transcode URL entirely (not sent as a sentinel), per `stream-url.js:63` and `PlayerActivity.java:2447`.
