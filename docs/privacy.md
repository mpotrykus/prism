---
title: Prism Privacy Policy
---

# Prism Privacy Policy

_Last updated: 2026-08-27_

Prism is a media browsing front end for a Plex Media Server you already own and run. It has
no server, no backend, and no account system of its own.

## What Prism collects

**Nothing.** The developer of Prism does not operate any server that Prism talks to, and does
not receive, store, or have access to any of your data, credentials, or viewing activity.

## What Prism sends, and to whom

Prism runs entirely on your device and talks directly to services **you** choose to connect it
to, using credentials **you** provide:

- **Plex** — your Plex sign-in and server/library data, to browse and play your own library.
  Required for the app to function.
- **YouTube Data API** (optional) — used only if you add your own YouTube API key, to look up
  trailers for titles Plex doesn't already have one for.
- **OpenRouter** (optional) — used only if you add your own OpenRouter API key, to generate
  AI-written themed rows (e.g. "Sci-Fi Comedies") from titles in your library.
- **OpenSubtitles** (optional) — used only if you configure a subtitle provider, to search for
  and download subtitles.

Each of these is a direct connection from your device to that service's own servers, under
that service's own terms and privacy policy. Prism does not proxy, log, or see any of this
traffic — it simply makes the request on your behalf, the same way a browser would.

## Where your credentials are stored

Your Plex token and any optional API keys/credentials are stored only on your device, encrypted
at rest with a device-local encryption key that never leaves the device. They are never sent
to the developer or to any server other than the service they're for.

## Third-party privacy policies

- [Plex Privacy Policy](https://www.plex.tv/about/privacy-legal/)
- [Google Privacy Policy](https://policies.google.com/privacy) (covers the YouTube Data API)
- [OpenRouter Privacy Policy](https://openrouter.ai/privacy)
- [OpenSubtitles Privacy Policy](https://www.opensubtitles.com/en/privacy)

## Children's privacy

Prism is not directed at children and does not knowingly collect information from anyone,
including children, because it does not collect information from anyone.

## Changes to this policy

If this policy changes, the updated version will be posted at this same URL with a new "last
updated" date.

## Contact

Questions about this policy can be raised via [issues on the Prism GitHub
repository](https://github.com/mpotrykus/prism/issues).
