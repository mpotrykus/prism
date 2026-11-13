# Prism

**A Netflix-style front end for your own Plex library — on your TV, your phone, your Xbox, and your browser.**

[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/mpotrykus)

![Prism home screen](docs/media/home.jpg)

---

## What is this?

Prism is a media browsing app that sits on top of a [Plex](https://www.plex.tv/) server you
already own. It doesn't host, stream, or provide any content of its own — it just gives your
existing library the kind of front end you'd expect from a paid streaming service:

- a big cinematic hero banner that cycles through your titles, with trailers
- rows of artwork you scroll sideways — *Continue Watching*, *Recently Added*, *My List*, genre rows
- a details page with cast, ratings, and recommendations
- a full-featured player with chapters, subtitles, and picture-quality controls

If you have a Plex server full of movies and shows and you want browsing it to *feel* like
Netflix instead of feeling like a file manager, that's what this is for.

![Browsing rows of posters](docs/media/browse.gif)

---

## Why it exists

Plex's own apps are fine, but they're built to sell you Plex's catalog as much as show you
yours. Prism is deliberately narrow: **your library, nothing else.** No storefront, no ads for
things you don't own, no channels you didn't ask for.

It's also built for the living room first. Everything is reachable with a **controller or a
remote's arrow keys** — not just a mouse — and the player is tuned for actually watching things: quality
that adapts to your connection, chapter skipping, subtitle search, and picture enhancement for
older or lower-resolution files.

---

## A look around

### Rows of your own artwork

Your libraries become rows. Genre rows are generated from your library's own tags, and if you
plug in an (optional) AI key, Prism will also invent themed rows like *"Sci-Fi Comedies"* and
fill them from titles you actually own.

![Poster rows](docs/media/rows.jpg)

### Per-library views

Each Plex library gets its own tab in the top nav, named however you named it in Plex.

![Movies library](docs/media/library.jpg)

### Search that understands your library

One search box across movies, shows, individual episodes, and collections.

![Search results](docs/media/search.jpg)

### Details without leaving the page

Picking a poster opens an overlay — synopsis, cast, ratings, similar titles, and a play button.
No page loads, no losing your place.

![Opening a title's details](docs/media/title-info.gif)

![Title details overlay](docs/media/title-info.jpg)

---

## The player

One play button, and then everything you'd want mid-film — controls fade away while you watch
and come back when you move.

![Player](docs/media/player.jpg)

Everything else lives behind one menu, so nothing clutters the picture.

![Player menu](docs/media/player-more.jpg)

![Navigating the player menus](docs/media/player.gif)

### Chapters

Jump by chapter, with real thumbnails pulled from the file itself.

![Chapter list](docs/media/player-chapters.jpg)

### Episodes and up next

Pick the next episode without leaving playback — and if you'd rather not, Prism plays it
automatically when the credits roll.

![Episode list](docs/media/player-episodes.jpg)

### Audio and subtitles

Switch audio tracks, or search for and load subtitles mid-film without hunting for files.

![Audio and subtitle menu](docs/media/player-audio-subtitles.jpg)

### Picture quality, in plain terms

![Effects menu](docs/media/player-effects.jpg)

- **Quality** — Prism watches your actual connection speed and picks a stream that won't stall.
  You can also pin it manually, or force the original file.
- **AI upscaling** — for older or low-resolution files, Prism can rebuild detail on the fly
  using real upscaling shaders (Anime4K for animation, AMD FSR for live action). It switches
  itself off when the file already matches your screen, so it never runs for nothing.
- **Sharpening and color boost** — subtle, optional, adjustable.
- **Ambient lighting** — spills the colors at the edge of the picture out into the black bars
  around it, so a widescreen film doesn't sit in a hard black box.
- **HDR** — HDR files play as HDR on hardware that supports it.

---

## Setting it up

The only thing Prism needs to know is *which Plex server is yours*. You sign in with your Plex
account the same way you would in any Plex app — a short code, no passwords typed on a TV
remote — and Prism finds your server and libraries for you.

![Plex connection settings](docs/media/settings-plex.png)

Trailers for titles where Plex doesn't have one are looked up automatically via TMDB — no
API key or account of yours required. Everything else is optional:

![Integration settings](docs/media/settings-integrations.png)

| Optional | What it adds |
|---|---|
| **OpenRouter API key** | AI-generated themed rows, refreshed weekly |
| **Subtitle provider** | Where subtitle searches come from |

If you share a Plex server with family, Prism also picks up your **Plex Home profiles** — switch
between them from the account menu, with a PIN prompt for the profiles that have one.

---

## Where it runs

| | Status |
|---|---|
| **Web browser** (desktop or phone) | Works today |
| **Android** (phone and tablet) | Works today, with a native player for smooth full-quality playback |
| **Xbox** | Works today via developer sideloading, with a native player for HDR and high-bitrate files |
| **Android TV / Fire TV** | Not yet — the Android app runs, but it isn't set up as a TV app |

Input-wise: mouse and touch, keyboard, and Xbox controllers all navigate the whole app. TV
remotes send the same arrow/select/back keys, so they should work too — that just hasn't been
tested on real remote hardware yet.

---

## How to install it

Builds are attached to every [GitHub release](https://github.com/mpotrykus/prism/releases). The
Microsoft Store and Google Play listings aren't public yet, so for now you sideload.

| Platform | Download | How |
|---|---|---|
| **Android** | `prism-<version>-android.apk` (older releases: `app-debug.apk`) | Open it on the device and allow installs from your browser or file manager when prompted, or `adb install -r <file>.apk`. |
| **Windows PC** | `prism-pc-sideload.zip` | Extract it and run the `Add-AppDevPackage.ps1` script inside. Windows will ask you to enable sideloading and trust the package's certificate the first time. |
| **Xbox** | `prism-xbox-sideload.zip` | Put the console in Dev Mode, then install the package through the Device Portal — upload the `.msixbundle` together with everything in its `Dependencies` folder in a single request. The console must also trust the signing certificate first. |
| **Web** | — | No hosted build yet; run it yourself with `npm run build` (see [Development](#development)). |

The Android APK is a debug-signed build, so Android may show an "unknown source" warning.

---

## Development

Prism is plain HTML/CSS/JS custom elements (no UI framework), built with [Vite](https://vitejs.dev/)
and wrapped natively per platform: [Capacitor](https://capacitorjs.com/) for Android and a
UWP + WebView2 shell (`uwp/PrismUwp/`) shared by Xbox and PC. `CLAUDE.md` has the architecture
notes and hardware-verified gotchas.

### Setup

```sh
npm install
cp .env.example .env   # optional
```

Put a free [TMDB API key](https://www.themoviedb.org/settings/api) in `.env` as `VITE_TMDB_API_KEY`
to enable the trailer fallback. Everything else works without it.

### Web

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (`--host`, so reachable from other devices on your LAN) |
| `npm run build` | Production build into `dist/` — servable as a plain PWA |
| `npm run preview` | Serve the production build locally |
| `npm test` / `npm run test:watch` | Vitest unit tests |

Test on a phone with `adb reverse` rather than the LAN IP: the app needs a secure context
(`crypto.subtle`), and `localhost` counts as one while a LAN address doesn't.

### Android

Requires Android Studio / the Android SDK and JDK 21.

| Command | What it does |
|---|---|
| `npm run android` | Build web, sync Capacitor, assemble a debug APK |
| `npm run android:deploy -- <ip>[:port]` | Build and install over wireless adb (run `adb tcpip 5555` once over USB first) |
| `npm run android:bundle` | Build a release `.aab` for Play Console |
| `npm run lowend -- create <profile>` | Fire Stick–style low-end emulator harness (see `scripts/lowend/lowend.mjs` for subcommands) |

### Xbox / PC

Requires Windows, Visual Studio with the UWP workload, and the Windows SDK.

| Command | What it does |
|---|---|
| `npm run uwp:sync` | Build web and copy it into the UWP shell's `www/` |
| `npm run xbox:build` | Sync, then build a sideloadable `.msixbundle` under `uwp/PrismUwp/AppPackages/` |
| `npm run xbox:deploy` | Rebuild and sideload to a paired console via `WinAppDeployCmd` |
| `npm run xbox:deploy:debug` | Same, and stream the WebView2 console back to your terminal |
| `npm run store:build` | Build the Microsoft Store `.msixupload` |

The console must be in Dev Mode and trust `PrismUwp_TemporaryKey.cer` (install it via the Device
Portal once). For day-to-day work, opening `uwp/PrismUwp/PrismUwp.sln` in Visual Studio and
deploying to the console as a **Remote Machine** is the most reliable route; for PC, use the
local-machine target.

---

## Things worth knowing

- **Prism does not give you anything to watch.** It's a viewer for a Plex server that you run,
  containing media that you supply. No server, no Prism.
- **It talks straight to your Plex server.** There's no Prism cloud, no extra account to make, and
  nothing about your library leaves your network except what you explicitly enable (trailer
  lookups, AI rows, subtitle searches).
- **It is not affiliated with Plex Inc.** It's an independent app that uses Plex's public API.
- **This product uses the TMDB API but is not endorsed or certified by TMDB.**
- **It's a personal project**, built and tested against one real library on real hardware. It
  works well there; expect rough edges elsewhere.

---

## Privacy

[Privacy Policy](https://mpotrykus.github.io/prism/privacy)

## License

[GPL-3.0](LICENSE)

<sub>Screenshots show a personal Plex library. Artwork, posters, and video frames belong to their
respective rights holders and are shown here only to illustrate the interface.</sub>
