import { paintWatchlistButton } from "./watchlist.js";
import { pickHeroItem, pickHeroItemFromPool, heroArtUrl, heroSubtitleText, heroShouldPlay } from "./logic/hero.js";

/* The hero banner: autoplay trailer resolution/crossfade, mute/play controls, and the
   focus/visibility/IntersectionObserver plumbing that decides whether it should
   currently be playing at all. Kept as one stateful controller (like pin.js's
   PinEntry/title-info.js's TitleInfoController) rather than split into stateless
   pieces - the crossfade timers and auto-advance recursion aren't worth forcing into a
   pure shape. ctx: { escape, plexFetch, mapItem, isInWatchlist, onAddToWatchlist,
   onRemoveFromWatchlist, onOpenTitleInfo, getConfig, getCurrentView, getSectionsForView }
   - the card's own collaborators and live state accessors (config/current view can
   change after construction, so these are accessor functions, not snapshotted values). */
export class HeroController {
  constructor(shadowRoot, ctx) {
    this._shadowRoot = shadowRoot;
    this._ctx = ctx;

    this._rowsEl = shadowRoot.querySelector(".rows");
    this._heroEl = shadowRoot.querySelector(".hero");
    this._mediaLayers = [shadowRoot.querySelector(".hero-media-a"), shadowRoot.querySelector(".hero-media-b")];
    this._activeLayer = 0;
    this._titleEl = shadowRoot.querySelector(".hero-title");
    this._subtitleEl = shadowRoot.querySelector(".hero-subtitle");
    this._summaryEl = shadowRoot.querySelector(".hero-summary");
    this._infoBtn = shadowRoot.querySelector(".hero-info-btn");
    this._watchlistBtn = shadowRoot.querySelector(".hero-watchlist-btn");
    this._muteBtn = shadowRoot.querySelector(".hero-mute-btn");
    this._playBtn = shadowRoot.querySelector(".hero-play-btn");

    this._item = null;
    this._video = null;
    /* Caps how many times resolveVideo will actually attempt a trailer (Plex extras
       fetch or YouTube search) per page load. Left running unattended, each hero
       auto-advance triggers a fresh trailer lookup, and YouTube's search endpoint is
       quota-limited (100/day) - after this many attempts, later advances just show the
       static backdrop image instead of burning more quota. */
    this._trailerResolveCap = 5;
    this._trailerResolveCount = 0;
    this._muted = false;
    /* userPaused is the user's explicit intent, independent of why playback is
       actually stopped right now (window unfocused / hero scrolled out of view). Actual
       playback is always the AND of "user hasn't paused" and "tab focused + hero
       visible" - see shouldPlay/updatePlayback below. */
    this._userPaused = false;
    this._inView = true;
    /* Track focus via events rather than polling document.hasFocus() directly - the HA
       Companion app's Android WebView never grants the page native input focus (no
       tappable field has been focused), so hasFocus() reads false forever there even
       though the app is genuinely in the foreground. Defaulting true and only flipping
       on a real blur event keeps focus-based pausing working on desktop browsers
       without permanently blocking playback in the companion app. */
    this._windowFocused = true;
    /* Same reasoning as windowFocused above, applied to Page Visibility: some WebViews
       (again including the Companion app's) never fire/track this correctly and
       document.visibilityState can read "hidden" forever even while genuinely onscreen.
       Track it via the event instead of polling the live property. */
    this._pageVisible = true;
    this._advancing = false;
    this._pausedByPlayer = false;

    this._wire();
  }

  get item() {
    return this._item;
  }

  isInViewport() {
    return this._inView;
  }

  pickItem(excludeKey, sections) {
    return pickHeroItem(excludeKey, sections, {
      genreBySection: this._ctx.getGenreBySection(),
    });
  }

  /* Picks and resolves the very first hero item on initial load - the rest of the
     card's data-loading orchestration (loadAll) awaits this before its first render,
     rather than this controller rendering on its own schedule. Picks from `pool` (the
     card's already-fetched on-deck/watchlist/recently-added items - see
     _buildHeroInitialPool) instead of the full genre-by-section fan-out, which loads in
     the background and isn't ready yet at this point - see data.js's loadAll. */
  async loadInitialItem(pool) {
    this._item = pickHeroItemFromPool(undefined, pool);
    if (this._item) {
      this._video = await this._resolveVideo(this._item);
    }
  }

  /* Called once the background genre-by-section fan-out lands (see data.js's
     loadBackgroundData) - only actually does anything if loadInitialItem's narrower pool
     came up empty (e.g. a library with nothing on deck/watchlisted/recently added), so
     the hero isn't left permanently blank for the rest of the session just because it
     picked before the full fan-out was available. */
  async fillFromGenresIfStillEmpty(sections) {
    if (this._item) return;
    const item = this.pickItem(undefined, sections);
    if (!item) return;
    this._item = item;
    this._video = await this._resolveVideo(item);
    this.show();
  }

  async advance() {
    if (this._advancing || this._ctx.getCurrentView() === "search") return;
    this._advancing = true;
    try {
      const next = this.pickItem(this._item?.ratingKey, this._ctx.getSectionsForView(this._ctx.getCurrentView()));
      if (!next) return;
      this._heroEl.classList.add("hero-transitioning");
      await new Promise((resolve) => setTimeout(resolve, 500));
      this._item = next;
      this._video = await this._resolveVideo(next);
      this.show(true, true);
    } finally {
      /* Always clear this, even if the view changed mid-transition - otherwise a stale
         "opacity: 0" class sticks around and the next show() (e.g. tabbing back to
         Home) renders invisibly. Real wall-clock time already elapsed via the awaits
         above, so the browser has already painted the faded-out frame - removing the
         class here still animates a proper fade-in, no rAF needed. */
      this._heroEl.classList.remove("hero-transitioning");
      this._advancing = false;
    }
  }

  async _resolveVideo(item) {
    if (this._trailerResolveCount >= this._trailerResolveCap) return null;
    this._trailerResolveCount++;
    const config = this._ctx.getConfig();
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${item.ratingKey}/extras`);
      const extras = data?.MediaContainer?.Metadata || [];
      const trailer = extras.find((e) => e.subtype === "trailer");
      const part = trailer?.Media?.[0]?.Part?.[0];
      if (part?.key) {
        return { type: "plex", url: `${config.plex_url}${part.key}?X-Plex-Token=${config.plex_token}` };
      }
    } catch (e) {
      // fall through to the youtube fallback below
    }
    if (!config.youtube_api_key) return null;
    const title = item.title || item.grandparentTitle || "";
    const query = `${title} ${item.year || ""} trailer`.trim();
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", "1");
      url.searchParams.set("q", query);
      url.searchParams.set("key", config.youtube_api_key);
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const videoId = data?.items?.[0]?.id?.videoId;
      if (!videoId) return null;
      /* enablejsapi=1 is required for the postMessage mute/unMute commands used by the
         mute button; embedding a specific known videoId (vs. the old listType=search
         trick) is fully supported and doesn't hit YouTube's "Error 153". */
      return {
        type: "youtube",
        embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&enablejsapi=1`,
      };
    } catch (e) {
      return null;
    }
  }

  shouldPlay() {
    return heroShouldPlay({
      heroUserPaused: this._userPaused,
      heroInView: this._inView,
      heroPageVisible: this._pageVisible,
      heroWindowFocused: this._windowFocused,
    });
  }

  updatePlayback() {
    const playing = this.shouldPlay();
    this._playBtn.textContent = playing ? "⏸" : "▶";
    const activeMedia = this._mediaLayers[this._activeLayer];
    const video = activeMedia.querySelector("video");
    if (video) {
      if (playing) video.play().catch((err) => console.warn("[plex-netflix-card] hero video.play() rejected:", err));
      else video.pause();
    }
    const iframe = activeMedia.querySelector("iframe");
    if (iframe) {
      const func = playing ? "playVideo" : "pauseVideo";
      iframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
    }
  }

  show(preserveMute = false, crossfade = false) {
    clearTimeout(this._staticTimer);
    if (!this._item || this._ctx.getCurrentView() === "search") {
      this._heroEl.style.display = "none";
      this._rowsEl.classList.remove("overlap-hero");
      return;
    }
    this._heroEl.style.display = "block";
    this._rowsEl.classList.add("overlap-hero");
    this._titleEl.textContent = this._item.title || this._item.grandparentTitle || "";
    this._subtitleEl.textContent = heroSubtitleText(this._item);
    this._summaryEl.textContent = (this._item.summary || "").slice(0, 240);

    const canWatchlist = this._item.type === "movie" || this._item.type === "show";
    this._watchlistBtn.style.display = canWatchlist ? "" : "none";
    if (canWatchlist) {
      this._watchlistBtn.classList.remove("busy", "error");
      paintWatchlistButton(this._watchlistBtn, this._ctx.isInWatchlist(this._item));
    }

    /* preserveMute: an auto-advance (trailer ended -> next random pick) keeps
       whatever sound preference the user already set, instead of resetting on every
       advance - only a fresh Home-tab load/switch should reset to the default
       (unmuted). */
    if (!preserveMute) {
      this._muted = false;
      this._muteBtn.textContent = "🔊";
    }

    const incoming = this._mediaLayers[1 - this._activeLayer];
    const outgoing = this._mediaLayers[this._activeLayer];
    incoming.style.backgroundImage = `url('${heroArtUrl(this._item, this._ctx.plexImageUrl)}')`;
    incoming.innerHTML = "";
    this._muteBtn.style.display = this._video ? "" : "none";
    this._playBtn.style.display = this._video ? "" : "none";
    if (this._video?.type === "plex") {
      incoming.innerHTML = `<video src="${this._video.url}" autoplay muted playsinline></video>`;
      const heroVideoEl = incoming.querySelector("video");
      heroVideoEl.muted = this._muted;
      heroVideoEl.addEventListener("ended", () => this.advance());
    } else if (this._video?.type === "youtube") {
      /* referrerpolicy is required here: HA's frontend sets <meta name="referrer"
         content="same-origin">, which strips the referrer on this cross-origin request
         entirely - YouTube's player then silently refuses to stream (reports
         "embedder.identity.missing.referrer" and never issues a single googlevideo.com
         request, confirmed via the network log). Setting it on the iframe itself
         overrides the page-level policy for just this element. */
      incoming.innerHTML = `<div class="hero-yt-wrap"><iframe src="${this._video.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
      /* setPlaybackQuality("highres") is advisory only (YouTube can still downgrade for
         bandwidth), but without it the embed defaults to a lower auto-selected quality.
         The player's postMessage API isn't ready the instant the iframe fires "load", so
         retry a few times over ~2s rather than sending once and hoping. Same reasoning
         applies to the "listening" handshake (needed for infoDelivery/ended detection)
         and to re-applying an unmuted preference, since the embed URL always starts
         muted regardless of the user's prior choice. */
      const ytIframe = incoming.querySelector("iframe");
      ytIframe.addEventListener("load", () => {
        ytIframe.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "heroPlayer" }), "*");
        if (!this._muted) {
          ytIframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "unMute", args: [] }), "*");
        }
        /* The embed always autoplays regardless of our desired state (see
           updatePlayback's earlier no-op call above). Don't correct that by firing
           pauseVideo immediately here, though - sending a pause as one of the very first
           commands over this raw (non-official-API) postMessage protocol, before the
           player's own autoplay sequence has settled, was observed to leave the embed
           permanently stuck on its unstarted/thumbnail state, never responding to later
           playVideo commands either (reproduced on the HA Companion app's WebView).
           Deferring this re-sync a beat, after the natural autoplay has had a chance to
           actually start, avoids racing it. */
        setTimeout(() => this.updatePlayback(), 400);
        for (let i = 0; i < 8; i++) {
          setTimeout(() => {
            ytIframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "setPlaybackQuality", args: ["highres"] }), "*");
          }, i * 250);
        }
      });
    } else {
      /* No trailer at all (no youtube_api_key, no Plex extra, quota exhausted, etc.) -
         still advance off the static backdrop after a fixed dwell so Home doesn't just
         sit on one item forever when video resolution fails. */
      this._staticTimer = setTimeout(() => this.advance(), 10000);
    }

    /* Restart the pan animation fresh for each new item rather than continuing mid-cycle -
       hero-media-a/b are long-lived elements reused across every hero advance, not fresh
       per item, so the class needs an explicit remove+reflow+re-add (same trick as the
       crossfade-notransition toggle below). */
    incoming.classList.remove("hero-pan");
    if (!this._video) {
      void incoming.offsetWidth;
      incoming.classList.add("hero-pan");
    }

    /* Cross-fade art/video between the two stacked .hero-media layers: `incoming` sits
       at opacity:0 until its "active" class is added, so simply toggling active on/off
       between the two layers dissolves one into the other. A plain tab-switch/first
       reveal (crossfade=false) instead pops the layer in instantly via a momentary
       hero-media-notransition class - forcing a reflow (offsetWidth) between adding and
       removing it is required, otherwise the browser coalesces both class changes into
       one style recalc and the opacity jump never gets suppressed correctly. */
    if (crossfade) {
      incoming.classList.add("hero-media-active");
    } else {
      incoming.classList.add("hero-media-notransition", "hero-media-active");
      void incoming.offsetWidth;
      incoming.classList.remove("hero-media-notransition");
    }
    outgoing.classList.remove("hero-media-active");
    this._activeLayer = 1 - this._activeLayer;
    /* Must run after the flip above - updatePlayback reads this._activeLayer to find
       the newly-incoming media element, not the outgoing one being torn down. */
    this.updatePlayback();

    clearTimeout(this._crossfadeCleanupTimer);
    this._crossfadeCleanupTimer = setTimeout(() => {
      outgoing.innerHTML = "";
      outgoing.style.backgroundImage = "";
    }, 650);
  }

  _wire() {
    this._infoBtn.addEventListener("click", () => {
      if (!this._item) return;
      this._ctx.onOpenTitleInfo(this._ctx.mapItem(this._item, false), "local");
    });
    this._watchlistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this._item) return;
      if (this._watchlistBtn.classList.contains("added")) {
        this._ctx.onRemoveFromWatchlist(this._item, this._watchlistBtn);
      } else {
        this._ctx.onAddToWatchlist(this._item, this._watchlistBtn);
      }
    });
    this._watchlistBtn.addEventListener("mouseenter", () => {
      if (this._watchlistBtn.classList.contains("added")) this._watchlistBtn.textContent = "−";
    });
    this._watchlistBtn.addEventListener("mouseleave", () => {
      if (this._watchlistBtn.classList.contains("added")) this._watchlistBtn.textContent = "✓";
    });
    this._muteBtn.addEventListener("click", () => {
      this._muted = !this._muted;
      this._muteBtn.textContent = this._muted ? "🔇" : "🔊";
      const activeMedia = this._mediaLayers[this._activeLayer];
      const video = activeMedia.querySelector("video");
      if (video) video.muted = this._muted;
      const iframe = activeMedia.querySelector("iframe");
      if (iframe) {
        const func = this._muted ? "mute" : "unMute";
        iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
      }
    });
    this._playBtn.addEventListener("click", () => {
      this._userPaused = !this._userPaused;
      this.updatePlayback();
    });
    /* Auto play/pause: resume only when the tab is focused/visible AND the hero is
       actually scrolled into view, but never override an explicit user pause. */
    this._observer = new IntersectionObserver(
      (entries) => {
        this._inView = entries[entries.length - 1].isIntersecting;
        this.updatePlayback();
      },
      { threshold: 0.4 }
    );
    this._observer.observe(this._heroEl);
    window.addEventListener("focus", () => {
      this._windowFocused = true;
      this.updatePlayback();
    });
    window.addEventListener("blur", () => {
      this._windowFocused = false;
      this.updatePlayback();
    });
    document.addEventListener("visibilitychange", () => {
      this._pageVisible = document.visibilityState === "visible";
      this.updatePlayback();
    });
    /* The hero trailer has no idea a full-screen video started playing on top of it
       (plex-player.js is a separate module, decoupled from the card) - without this it
       keeps playing, audio and all, behind the player. Only restores playback on close
       if this is what paused it - never overrides a pause the user set themselves via
       the hero's own button. */
    window.addEventListener("streaming-player-open", () => {
      if (!this._userPaused) {
        this._userPaused = true;
        this._pausedByPlayer = true;
        this.updatePlayback();
      }
    });
    window.addEventListener("streaming-player-close", () => {
      if (this._pausedByPlayer) {
        this._pausedByPlayer = false;
        this._userPaused = false;
        this.updatePlayback();
      }
    });
    /* YouTube's embed only starts posting "infoDelivery" state updates (playerState 0 =
       ended) after it receives a "listening" handshake - sent once the iframe loads,
       see show() above. No official iframe_api script is loaded, so this raw
       postMessage protocol is the only way to detect trailer-end without it. */
    window.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (data.event === "infoDelivery" && data.info && data.info.playerState === 0) {
        this.advance();
      }
    });
  }
}
