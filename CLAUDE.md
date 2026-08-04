# Prism

A standalone rewrite of a Netflix-style Plex browsing dashboard, targeting **web, Android, and Xbox**, with **remote (Amazon Fire TV/Fire Stick), touch, and controller (Xbox gamepad)** input support. No build step — plain HTML/CSS/JS, loaded as static files (a PWA).

## Origin

The UI (`plex-netflix-card.js`) started life as `custom:plex-netflix-card`, a hand-written vanilla-JS Home Assistant Lovelace custom card running on a home server (`raspi-server`), browsing a personal Plex library with Netflix-style rows, a hero banner, search, Kids Mode, AI-generated genre rows, etc. That HA-hosted version is the **feature-complete reference implementation** — extensive build history (every feature, every bug, every fix) lives in this machine's memory for the `Desktop` project, not in this repo. If you need to know *how* an existing feature was originally built or why a specific decision was made, check there first — see `reference_dashboard_history` in this project's memory.

This repo is the rewrite: pull the card out of Home Assistant entirely so it can run as its own installable app on multiple platforms/input modes HA's Lovelace panel never had to support.

## Current state (scaffold only, no commits yet)

- `index.html` — shell: unlock overlay (vault), mounts `<streaming-settings-modal>`, then boots.
- `app.js` — bootstrap. Registers the service worker, creates a detached `<plex-netflix-card>`, wires `open-settings`/`settings-saved` events to the settings modal, and decides whether to show the WebAuthn unlock gate before booting (`window.StreamingVault.hasSecrets()`).
- `vault.js` (`window.StreamingVault`) — encrypts the three sensitive config fields (`plex_token`, `youtube_api_key`, `openrouter_api_key`) at rest instead of plaintext localStorage. Three tiers, auto-selected per device: `prf` (WebAuthn PRF extension derives the AES key fresh each unlock, key never stored) → `gate` (non-extractable IndexedDB key, gated behind a WebAuthn user-verification prompt) → `plain` (non-extractable IndexedDB key, no gate — used when no platform authenticator exists). This replaces HA's old convention of just inlining tokens in dashboard JSON.
- `settings.js` (`window.StreamingSettings` + `<streaming-settings-modal>`) — everything *not* secret (plex_url, machine_id, sections, tuning knobs) lives in plain localStorage; merges with decrypted vault secrets into the "full config" the card expects via `setConfig()`/`refreshConfig()`. This is the replacement for HA's Lovelace card-config YAML editor.
- `plex-netflix-card.js` — the actual UI. Ported near-verbatim from the HA card; confirmed already decoupled from `hass`/`callService` (grepped clean) — it now reads everything from `this._config` the same shape `settings.js` produces.
- `sw.js` — network-first service worker for the app shell (deliberately *not* cache-first: this app changes often during dev, and cache-first was already bitten once by silently serving a stale `plex-netflix-card.js`). Cross-origin calls (Plex/YouTube/OpenRouter) bypass it entirely.
- `manifest.webmanifest` — PWA manifest. Currently `orientation: landscape`, `display: fullscreen` — inherited from the TV-kiosk HA use case. **Will need revisiting for phone/touch/Android use** (portrait, standalone vs fullscreen) once that platform is actually worked on.
- **Known gap:** `manifest.webmanifest` references `icons/icon-192.png` and `icons/icon-512.png` — that `icons/` directory doesn't exist yet (only `assets/plex-logo.png` is present). Needed before this installs cleanly as a PWA on any platform.

## Architecture invariant carried over from the HA version

**No backend, no proxy.** The card talks directly to Plex's HTTP API, the YouTube Data API v3, and the OpenRouter API from the browser/client. This was deliberately verified (not assumed) against Plex: it sends CORS headers back correctly *as long as the token is passed as a query param, not a header* — a header token triggers a preflight Plex won't answer. Keep this in mind before "cleaning up" any URL-building code to move the token into headers.

This trust model (bare API tokens visible in client-side config/devtools) was acceptable for a LAN-only HA panel. Revisit explicitly once Android/Xbox targets mean the app may be reachable off the home LAN — vault.js's WebAuthn gating protects against *local* disk/backup exposure, not against the token being visible to anyone who can open devtools on an unlocked session.

## Technical gotchas worth knowing before touching Plex/YouTube integration code

- **Plex's `Genre` field on list endpoints is truncated to ~2 tags per item.** Per-item genre filtering alone is not reliable for anything genre-based (Kids Mode-style blocking, genre rows, etc.) — the original implementation had to add a second bucket-level check (does the *row's own source genre* match) independent of each item's own truncated tags.
- **The YouTube trailer embed uses the raw postMessage protocol, not the official `iframe_api`.** Sending a command (e.g. `pauseVideo`) before the player's own handshake has settled can leave the embed permanently stuck, unresponsive even to later real taps on YouTube's own UI. Any new command sent to that iframe needs to go through the existing handshake-then-command sequencing already in the file, not a fire-and-forget postMessage on `load`.
- **Cross-origin YouTube iframes need `referrerpolicy="strict-origin-when-cross-origin"` set directly on the `<iframe>`.** A page-level `<meta name="referrer">` policy that's too strict (as HA's frontend shipped) silently prevents YouTube from ever starting playback, with no on-screen error — verify via actual `videoplayback` network requests, not just "the player rendered."
- **Plex Android deep links** (`plex://libraries/<machine_id>/...`) are fully solved for movie/show/episode/collection/playlist — see the `plex_android_deeplink` reference. No "play now" intent exists on Android; the ceiling is landing on the item's details page. These links are Android-app-specific — gate on a UA check and fall back to a plain web link otherwise.
- **Shadow-DOM custom-element gotcha:** `mousedown` on a sibling element fires an input's `blur` *before* that sibling's `click` handler runs. Don't rely on the blur listener alone to collapse/close UI state that a click handler is also explicitly changing in the same gesture — do the explicit state change in the click handler itself.

## Platform work not yet started

This scaffold only covers the web/desktop-mouse case (inherited as-is from the HA card). None of the following exist yet:

- **Touch.** The original card was resized for narrow viewports (mobile poster grid at 70% scale) but that was a *sizing* pass for viewing on a phone, not a touch-interaction pass — hover-dependent UI (mute/play button reveal, watchlist button hover state, row arrow visibility) needs an explicit touch-input audit.
- **Remote (Fire TV/Fire Stick).** Fire OS is Android-based; a Fire TV app is typically an Android TV-style app hosting this content in a WebView. Amazon's own Fire TV UX guidelines require full D-pad-only navigation (no feature may depend on hover or touch) with a clearly visible focus indicator on every focusable element. The Fire TV remote's D-pad/select/back are very likely delivered to the page as ordinary key events (arrow keys, Enter, Escape/Back-equivalent) rather than through the Gamepad API — **verify this empirically once real Fire TV hardware/emulator access exists**, don't assume. Nothing in this codebase currently has deliberate focus-based (as opposed to mouse-hover-based) navigation at all — hover-dependent UI (mute/play button reveal, watchlist button hover state, row arrow visibility) needs an audit before D-pad nav can work.
- **Controller (Xbox gamepad).** Nothing in this codebase currently reads the Gamepad API. **Worth checking early whether Xbox's own browser/PWA host already maps controller D-pad/thumbstick input to the same key-event-equivalent navigation Fire TV likely uses** (Microsoft's Xbox web-app guidance documents exactly this "gamepad-to-keyboard" behavior for D-pad/A/B in some Xbox browser/PWA contexts) — if so, the Fire TV and Xbox D-pad cases may collapse into one shared keyboard-equivalent focus-navigation implementation instead of two separate input systems (one key-event-based, one raw Gamepad-API-based). Confirm on real hardware before designing either. If a genuine raw Gamepad API path does end up needed (e.g. a physical Xbox controller paired to a phone/PC for this same app), watch for the double-handling trap noted in `feedback_double_handle_input_nav`: if the runtime already provides native focus navigation for those buttons, don't also run a custom polling handler for the same directions.

## Related repos on this machine

- `moonlight-xbox` — a native Xbox UWP game-streaming app (unrelated product, same machine/author). Not code to reuse directly (different stack: C++/CX + XAML vs. this repo's vanilla web JS), but its memory has real lessons about Xbox gamepad/focus-navigation pitfalls worth checking against before implementing controller support here.
