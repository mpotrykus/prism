# Store submission checklist

What's done in-repo vs. what's left as an account/console action for each store. Store listing
copy lives in `store-listing.md`, privacy policy in `privacy.md`.

## Google Play

**Done in-repo:**
- Release signing key generated (`android/prism-upload-key.jks`, gitignored) and wired into
  `android/app/build.gradle` via `android/keystore.properties` (gitignored).
- `npm run android:bundle` builds a signed `app-release.aab` at
  `android/app/build/outputs/bundle/release/app-release.aab` — verified locally.
- App icon (adaptive, branded) already in place under `android/app/src/main/res/mipmap-*`.
- Store listing copy and screenshots ready (`store-listing.md`, `media/`).
- Privacy policy drafted (`privacy.md`).

**Still needed (Play Console, console.play.google.com):**
1. Google Play Developer account ($25 one-time) if you don't already have one.
2. Host `privacy.md` at a public URL — GitHub Pages from this repo's `/docs` folder is the
   easiest option (Settings → Pages → Deploy from branch → `main` / `/docs`), giving you
   `https://mpotrykus.github.io/prism/privacy.html`.
3. Create the app in Play Console, upload `app-release.aab` to Internal testing first (fastest
   path to confirm the listing works before wider release).
4. Data safety form — answer based on `privacy.md`: no data collected or shared by the developer.
   Plex, OpenRouter, and OpenSubtitles are contacted directly using the user's own credentials,
   not proxied; TMDB (trailer lookups) and YouTube (trailer/embedded playback) are contacted
   directly too, but using the app's own bundled TMDB API key rather than anything user-supplied.
5. Content rating questionnaire, target audience (not for children), app category, contact
   email, paste store listing copy from `store-listing.md`, upload screenshots from `media/`
   (resize/crop to Play's required aspect ratios — phone screenshots need min 320px) and the
   feature graphic (`media/feature-graphic.png`, 1024x500, already rendered).
6. **Back up `android/prism-upload-key.jks` and `android/keystore.properties` somewhere safe
   off this machine.** Losing both means losing the ability to publish updates under this
   signing identity (Play App Signing can recover from a lost *upload* key via support, but
   it's friction you don't want).
7. Promote Internal testing → Production once it looks right.

## Microsoft Store (PC + Xbox via the shared UWP shell)

**Not yet done in-repo** (per your call to keep `hevcPlayback` and pursue the capability
request rather than dropping it):
1. File the restricted-capability request for `hevcPlayback` in Partner Center **before**
   submitting a package that declares it — Store certification fails without approval.
   Location: Partner Center → your app → Product management → advanced features, or via the
   submission's capability-declaration prompt, which links directly to the request form.
2. This is naturally slower than a plain submission — expect it to be the long pole. Nothing
   else below is blocked while it's pending except final certification.

**Still needed regardless of the capability request:**
1. Microsoft Partner Center developer account ($19 individual / $99 company, one-time).
2. Reserve the app name "Prism" in Partner Center.
3. In Visual Studio, open `uwp/PrismUwp/PrismUwp.sln` → right-click the project → **Publish →
   Associate App with the Store** → sign in, pick the reserved name. This rewrites
   `Package.appxmanifest`'s `Identity` (Name/Publisher) to match your reserved Partner Center
   identity and adds a Store association file — replaces the current self-signed
   `PrismUwp_TemporaryKey.pfx` identity, which was only ever a Dev Mode sideload convenience.
4. Build the submission package via VS's **Create App Packages** wizard (not `xbox:build`,
   which produces a self-signed sideload package) — choose "Microsoft Store" as the
   distribution method so VS signs it with your Store association instead of the temp key.
5. Age ratings questionnaire (IARC), same privacy policy URL as above, store listing copy from
   `store-listing.md`, screenshots from `media/` resized to the Store's required dimensions.
6. Decide submission scope: `Package.appxmanifest` currently declares only
   `TargetDeviceFamily Name="Windows.Universal"`, so as submitted this is a PC/Windows listing.
   An Xbox-specific listing needs an additional `Windows.Xbox` device family declaration and
   real hardware validation of the two open risks noted in `CLAUDE.md` (gamepad Guide focus
   trap fix, WebView2-on-Xbox cert risk) before it's worth pursuing — do this as a separate,
   later submission rather than blocking the PC listing on it.
