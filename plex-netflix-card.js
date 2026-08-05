import { wireLinearNav, registerNavHandler } from "./focus-nav.js";
import { App } from "@capacitor/app";

const STYLE = `
  :host {
    display: block;
    width: 100%;
    min-height: 100vh;
    background: linear-gradient(160deg, #121215 0%, #0a0a0c 45%, #131316 100%);
    background-attachment: fixed;
    color: #fff;
    font-family: var(--paper-font-body1_-_font-family, "Roboto", sans-serif);
    box-sizing: border-box;
    --header-h: 64px;
    --hero-h: max(100vh, 600px);
    --hero-overlap: 110px;
    --row-title-clearance: 32px;
    --hero-overlap: 110px;
    /* Android WebView doesn't support env(safe-area-inset-*) (iOS-only); Capacitor's
       core SystemBars plugin instead injects --safe-area-inset-* custom properties on
       <html>, which pierce the shadow boundary since custom properties inherit. Combine
       both so this still works on iOS/web (env) and Android (var). */
    --safe-top: max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px));
    --safe-bottom: max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px));
  }
  * { box-sizing: border-box; }
  .wrap { display: flex; flex-direction: row; min-height: 100vh; }
  .content { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
  .sidenav {
    flex: 0 0 45px;
    position: sticky;
    top: 0;
    align-self: flex-start;
    height: 100vh;
    padding: 24px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    background: rgba(255,255,255,0.03);
    border-right: 1px solid rgba(255,255,255,0.06);
    overflow: hidden;
    transition: flex-basis 0.22s ease;
    z-index: 30;
  }
  .sidenav:hover {
    flex-basis: 130px;
  }
  .nav-top, .nav-bottom {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .nav-item {
    position: relative;
    height: 30px;
    padding: 0 7px;
    display: flex;
    align-items: center;
    gap: 12px;
    color: rgba(255,255,255,0.7);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    transition: color 0.15s ease;
  }
  .nav-item:hover { color: #fff; }
  .nav-item.active { color: #e5a00d; }
  .nav-icon {
    width: 30px;
    height: 30px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    transition: background-color 0.15s ease;
  }
  .nav-item:hover .nav-icon { background: rgba(255,255,255,0.08); }
  .nav-item.active .nav-icon { background: rgba(229,160,13,0.18); }
  .nav-item svg { width: 20px; height: 20px; flex: none; }
  .nav-label {
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .sidenav:hover .nav-label {
    opacity: 1;
  }
  /* Only ever shown at the mobile breakpoint below - the hover sidenav has room for
     every item on desktop, so there's nothing to collapse there. */
  .nav-more { display: none; }
  .main { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .hero {
    position: relative;
    z-index: 2;
    width: 100%;
    height: var(--hero-h);
    min-height: 320px;
    overflow: hidden;
    display: none;
  }
  .hero-media {
    position: absolute;
    inset: 0;
    z-index: 1;
    opacity: 0;
    background-size: cover;
    background-position: center 20%;
    transition: opacity 0.6s ease;
  }
  .hero-media.hero-media-active { opacity: 1; z-index: 2; }
  /* Slow Ken-Burns-style drift for a static backdrop (no trailer available) so it
     doesn't feel totally frozen for its ~10s dwell. Not applied when a video/iframe
     layer is showing - that already has real motion of its own. */
  .hero-media.hero-pan { animation: hero-pan 9s ease-in-out infinite alternate; }
  @keyframes hero-pan {
    0% { background-position: center 5%; }
    100% { background-position: center 45%; }
  }
  .hero-media.hero-media-notransition { transition: none; }
  .hero-media video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .hero-yt-wrap {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 177.78vh;
    height: 100%;
    min-width: 100%;
    min-height: 56.25vw;
    transform: translate(-50%, -50%);
  }
  .hero-yt-wrap iframe { width: 100%; height: 100%; border: 0; pointer-events: none; }
  .hero::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(10,10,12,0.8) 0%, rgba(10,10,12,0.25) 45%, rgba(10,10,12,0) 70%);
    z-index: 2;
  }
  .hero-fade {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 55%;
    background: linear-gradient(180deg, rgba(10,10,12,0) 0%,  #0a0a0c88 30%, #0a0a0c 100%);
    z-index: 3;
    pointer-events: none;
  }
  .hero-info { position: absolute; left: 40px; bottom: 294px; max-width: 46%; z-index: 4; }
  .hero-title {
    font-size: 34px;
    font-weight: 800;
    text-shadow: 0 2px 12px rgba(0,0,0,0.7);
    margin-bottom: 12px;
    overflow-wrap: break-word;
  }
  .hero-subtitle {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255,255,255,0.75);
    text-shadow: 0 1px 6px rgba(0,0,0,0.7);
    margin-bottom: 12px;
  }
  .hero-subtitle:empty { display: none; }
  .hero-summary {
    font-size: 14px;
    line-height: 1.5;
    color: rgba(255,255,255,0.85);
    text-shadow: 0 1px 6px rgba(0,0,0,0.7);
    margin-bottom: 18px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hero-info-btn {
    padding: 10px 24px;
    border-radius: 6px;
    border: none;
    background: #fff;
    color: #111;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
  }
  .hero-info-btn:hover { background: rgba(255,255,255,0.85); }
  .hero-buttons { display: flex; align-items: center; gap: 12px; }
  .hero-watchlist-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: rgba(20,20,24,0.5);
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .hero-watchlist-btn:hover { background: rgba(20,20,24,0.8); }
  .hero-watchlist-btn.added { color: #e5a00d; border-color: rgba(229,160,13,0.7); }
  .hero-watchlist-btn.busy { pointer-events: none; opacity: 0.6; }
  .hero-watchlist-btn.error { color: #ff6b6b; border-color: rgba(255,107,107,0.7); }
  .hero-mute-btn {
    position: absolute;
    right: 40px;
    bottom: 294px;
    z-index: 5;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: rgba(20,20,24,0.5);
    color: #fff;
    font-size: 18px;
    cursor: pointer;
  }
  .hero-mute-btn:hover { background: rgba(20,20,24,0.8); }
  .hero-play-btn {
    position: absolute;
    right: 94px;
    bottom: 294px;
    z-index: 5;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: rgba(20,20,24,0.5);
    color: #fff;
    font-size: 18px;
    cursor: pointer;
  }
  .hero-play-btn:hover { background: rgba(20,20,24,0.8); }
  .hero-info { transition: opacity 0.5s ease; }
  .hero.hero-transitioning .hero-info { opacity: 0; }
  .header {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--header-h);
    margin-bottom: calc(-1 * var(--header-h));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: calc(28px + var(--safe-top)) 18px 50px;
    background: linear-gradient(180deg, rgba(10,10,12,0.95) 0%, rgba(10,10,12,0.7) 70%, rgba(10,10,12,0) 100%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    mask-image: linear-gradient(180deg, #000 0%, #000 70%, transparent 100%);
    -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 70%, transparent 100%);
  }
  .plex-logo { height: 28px; width: auto; flex: 0 0 auto; }
  .search-wrap {
    position: relative;
    flex: none;
    width: 40px;
    height: 40px;
    margin-left: auto;
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.08);
    overflow: hidden;
    transition: width 0.25s ease, border-color 0.15s ease, background-color 0.15s ease;
  }
  .search-wrap.expanded {
    width: min(360px, 60vw);
    border-color: #e5a00d;
    background: rgba(255,255,255,0.12);
  }
  .search-toggle {
    position: absolute;
    top: 0;
    right: 0;
    width: 40px;
    height: 40px;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 2;
  }
  .search-toggle:hover { color: #fff; }
  .search-toggle svg { 
    width: 18px; 
    height: 18px; 
    flex: none; 
    position: relative;
    top: -2px;
    right: -1px;
  }
  .search {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0 44px 0 16px;
    border: none;
    background: transparent;
    color: #fff;
    font-size: 14px;
    outline: none;
  }
  .search-page { padding: calc(var(--header-h) + 24px) 0 20px; }
  .search-page-group { padding: 0 45px; margin-bottom: 32px; }
  .search-page-group-header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  .search-page-group-title { font-size: 18px; font-weight: 600; }
  .search-page-group-title-wrap { display: flex; align-items: center; gap: 10px; }
  .search-page-group-image { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; flex: none; }
  .search-page-see-all {
    flex: none;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.6);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 0;
  }
  .search-page-see-all:hover { color: #e5a00d; }
  .search-page-back {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.85);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    padding: 0 45px 20px;
  }
  .search-page-back:hover { color: #e5a00d; }
  .search-page-grid { display: flex; flex-wrap: wrap; gap: 24px; }
  .rows {
    position: relative;
    z-index: 2;
    padding: 0 0 50px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .rows.overlap-hero { margin-top: -200px; }
  .row-section { min-width: 0; }
  .row-title { 
    font-size: 16px; 
    font-weight: 600; 
    margin-bottom: 2px; 
    padding: 0 45px; 
    height: 5px;
  }
  .row-scroll-wrap { position: relative; }
  .row-scroller {
    display: flex;
    gap: 24px;
    overflow-x: auto;
    scroll-behavior: smooth;
    /* overflow-x:auto forces overflow-y to auto too (CSS overflow computed-value rule),
       so top/bottom padding here isn't cosmetic - it's the only thing keeping the
       poster glow bleed from being clipped. Note the blur(20px) filter on .glow paints
       well beyond its own box (roughly 2-3x the blur radius), so this needs much more
       room than the glow's inset(-14px) box alone would suggest - confirmed empirically,
       24px/30px still hard-clipped the top/bottom of the glow. */
    padding: 45px 45px 45px;
    /* Without this, overflow-x:auto computes overflow-y to auto too (see comment
       above), and rank-number's absolute-positioned bleed past the padding gives
       What's Popular real vertical scrollable overflow other rows don't have -
       the mouse wheel was getting captured into that row instead of the page. */
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .row-scroller::-webkit-scrollbar { display: none; width: 0; height: 0; }
  .scroll-arrow {
    position: absolute;
    top: 45px;
    bottom: 45px;
    width: 44px;
    border: none;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    cursor: pointer;
    z-index: 5;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
    background: linear-gradient(90deg, rgba(10,10,12,0.9), rgba(10,10,12,0));
  }
  .scroll-arrow.right {
    left: auto;
    right: 0;
    background: linear-gradient(270deg, rgba(10,10,12,0.9), rgba(10,10,12,0));
  }
  .scroll-arrow.left { left: 0; }
  .scroll-arrow:hover { background-color: rgba(0,0,0,0.35); }
  .scroll-arrow.hidden { opacity: 0 !important; pointer-events: none; }
  .row-scroll-wrap:hover .scroll-arrow:not(.hidden) { opacity: 1; }
  .message, .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    min-height: calc(100vh - var(--header-h));
    padding: 24px;
    text-align: center;
    color: rgba(255,255,255,0.6);
    font-size: 15px;
  }
  .message svg, .empty svg { width: 48px; height: 48px; color: rgba(255,255,255,0.3); }
  .loading-wrap { display: flex; align-items: center; justify-content: center; min-height: calc(100vh - var(--header-h)); }
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.75);
    border-radius: 50%;
    animation: plex-netflix-spin 0.8s linear infinite;
  }
  @keyframes plex-netflix-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes plex-netflix-row-in {
    from { opacity: 0; transform: translateY(22px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes plex-netflix-poster-in {
    from { opacity: 0; transform: translateY(16px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .row-section.row-anim-in { animation: plex-netflix-row-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .poster.poster-anim-in { animation: plex-netflix-poster-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
  @media (prefers-reduced-motion: reduce) {
    .row-section.row-anim-in, .poster.poster-anim-in { animation: none; }
    .poster .card img { transition: none; }
  }

  .poster {
    position: relative;
    isolation: isolate;
    flex: 0 0 160px;
    cursor: pointer;
  }
  .poster .glow {
    position: absolute;
    inset: -14px;
    background-image: var(--img);
    background-size: cover;
    background-position: center;
    filter: blur(20px) saturate(1.2) brightness(0.7);
    opacity: 0.55;
    z-index: -1;
    border-radius: 22px;
  }
  .poster .card {
    position: relative;
    border-radius: 14px;
    overflow: hidden;
    background: #16161a;
    aspect-ratio: 2 / 3;
    transition: transform 0.18s ease;
  }
  .poster:hover .card { transform: scale(1.06); }
  .poster .card img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; transition: opacity 0.35s ease; }
  .poster.img-loaded .card img { opacity: 1; }
  .poster .img-fallback {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: linear-gradient(160deg, #232329 0%, #0e0e11 100%);
  }
  .poster .img-fallback .badge {
    width: 40%;
    aspect-ratio: 1;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(229,160,13,0.14);
    box-shadow: 0 0 0 1px rgba(229,160,13,0.25) inset;
    color: #e5a00d;
  }
  .poster .img-fallback svg { width: 52%; height: 52%; }
  .poster.img-error .card img { display: none; }
  .poster.img-error .img-fallback { display: flex; }
  .poster .img-spinner {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .poster .img-spinner .spinner-sm {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.75);
    border-radius: 50%;
    animation: plex-netflix-spin 0.8s linear infinite;
  }
  .poster.img-loaded .img-spinner, .poster.img-error .img-spinner { display: none; }
  .poster .progress {
    z-index: 2;
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgba(255,255,255,0.25);
  }
  .poster .progress .bar { height: 100%; background: #e5a00d; }
  .poster .watched-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 3;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(20,20,24,0.65);
    color: #e5a00d;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .poster .watched-badge svg { width: 13px; height: 13px; }
  .poster .caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 125px 12px 12px;
    background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.88) 90%);
  }
  .poster .caption .t {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .poster .caption .s {
    font-size: 11px;
    color: rgba(255,255,255,0.65);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .poster .watchlist-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 3;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: rgba(20,20,24,0.55);
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease, background 0.15s ease;
  }
  .poster:hover .watchlist-btn,
  .poster .watchlist-btn:focus-visible { opacity: 1; pointer-events: auto; }
  .poster .watchlist-btn:hover { background: rgba(20,20,24,0.85); }
  .poster .watchlist-btn.added { opacity: 1; pointer-events: auto; color: #e5a00d; border-color: rgba(229,160,13,0.7); }
  .poster .watchlist-btn.busy { opacity: 1; pointer-events: none; }
  .poster .watchlist-btn.error { opacity: 1; color: #ff6b6b; border-color: rgba(255,107,107,0.7); }
  @media (hover: none) {
    .poster .watchlist-btn { opacity: 1; pointer-events: auto; background: rgba(20,20,24,0.7); }
  }
  .poster.landscape { flex-basis: 320px; }
  .poster.landscape .card { aspect-ratio: 16 / 9; }
  .poster.landscape .caption { padding: 60px 12px 12px; }
  /* Top-10-style big rank numbers (e.g. HBO Max) for rank-ordered rows like What's
     Popular. Ties into this card's existing amber accent (#e5a00d, used for the
     kids-mode PIN/watchlist-added color) instead of HBO's plain white/steel numerals -
     our own take on the same idea. .rank-number is absolutely positioned (not a normal
     flex sibling) specifically so its taller-than-poster font-size doesn't stretch
     row-scroller's flex height and inflate the row's padding - .rank-item's own height
     comes only from its poster child, same as every other row. */
  .rank-item { position: relative; display: flex; flex: 0 0 auto; }
  .rank-item .poster { position: relative; z-index: 1; margin-left: 90px; }
  .rank-number {
    position: absolute;
    left: -6px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 260px;
    font-weight: 900;
    line-height: 1;
    letter-spacing: -14px;
    font-style: italic;
    color: transparent;
    opacity: 0.3;
    -webkit-text-stroke: 2px rgba(229, 160, 13, 0.5);
    background: linear-gradient(180deg, rgba(140,140,140,0.9) 0%, rgba(90,65,15,0.5) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
    z-index: 0;
  }
  .pin-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.72);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center;
    justify-content: center;
    /* Higher than .profile-overlay (100) - the profile switcher stays open underneath
       while this collects a protected profile's PIN, so this has to paint on top of it. */
    z-index: 110;
    outline: none;
  }
  .pin-overlay.open { display: flex; }
  .pin-modal {
    width: 300px;
    max-width: 88vw;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 28px 28px 20px;
    text-align: center;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  }
  .pin-modal.shake { animation: pinShake 0.4s ease; }
  @keyframes pinShake {
    10%, 90% { transform: translateX(-3px); }
    20%, 80% { transform: translateX(5px); }
    30%, 50%, 70% { transform: translateX(-7px); }
    40%, 60% { transform: translateX(7px); }
  }
  .pin-icon {
    width: 44px;
    height: 44px;
    margin: 0 auto 12px;
    border-radius: 50%;
    background: rgba(229,160,13,0.15);
    color: #e5a00d;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pin-icon svg { width: 22px; height: 22px; }
  .pin-title { font-size: 15px; font-weight: 700; margin-bottom: 18px; }
  .pin-dots { display: flex; justify-content: center; gap: 14px; margin-bottom: 10px; }
  .pin-dot {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.4);
    background: transparent;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .pin-dot.filled { background: #e5a00d; border-color: #e5a00d; }
  .pin-error {
    color: #ff6b6b;
    font-size: 12px;
    font-weight: 600;
    height: 16px;
    margin-bottom: 8px;
    visibility: hidden;
  }
  .pin-error.visible { visibility: visible; }
  .pin-keypad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .pin-key {
    height: 50px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.05);
    color: #fff;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
  }
  .pin-key:hover { background: rgba(255,255,255,0.12); }
  .pin-key:active { background: rgba(229,160,13,0.25); }
  .pin-key-empty { visibility: hidden; cursor: default; }
  .pin-cancel {
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.55);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .pin-cancel:hover { color: #fff; }
  .nav-profile[hidden] { display: none; }
  .nav-profile-avatar {
    width: 22px; height: 22px; border-radius: 50%; overflow: hidden; flex: none;
    display: flex; align-items: center; justify-content: center;
  }
  .nav-profile-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .profile-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.72);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
    outline: none;
  }
  .profile-overlay.open { display: flex; }
  .profile-modal {
    width: 360px;
    max-width: 88vw;
    max-height: 80vh;
    overflow-y: auto;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  }
  .profile-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; text-align: center; }
  .profile-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
  .profile-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    background: rgba(255,255,255,0.05); border-radius: 10px; padding: 10px 12px;
  }
  .profile-row.active { background: rgba(229,160,13,0.12); }
  .profile-row.busy { opacity: 0.6; pointer-events: none; }
  .profile-avatar {
    width: 34px; height: 34px; border-radius: 50%; overflow: hidden; flex: none;
    display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.6);
    background: rgba(255,255,255,0.08);
  }
  .profile-avatar svg { width: 20px; height: 20px; }
  .profile-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .profile-name { font-size: 14px; font-weight: 600; flex: 1 1 auto; min-width: 0; }
  .profile-switch-btn {
    border: none; border-radius: 8px; padding: 7px 14px; font-size: 12.5px; font-weight: 700;
    cursor: pointer; background: rgba(255,255,255,0.1); color: #fff; white-space: nowrap;
  }
  .profile-switch-btn:hover { background: rgba(255,255,255,0.18); }
  .profile-switch-btn:disabled { opacity: 0.5; cursor: default; }
  .profile-row-status { flex: 1 0 100%; color: #ff6b6b; font-size: 11.5px; font-weight: 600; }
  .profile-cancel {
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.55);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .profile-cancel:hover { color: #fff; }
  /* Mobile-only overflow menu for the bottom nav bar (see .nav-more) - collects Profile/
     Kids Mode/Settings plus any library tabs past the mobile visible cap. Below
     .profile-overlay/.pin-overlay in z-index on purpose: rows in here delegate to those
     same nav items via a real .click(), closing this sheet first, so it never needs to
     paint above something it just handed off to. */
  .more-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    display: none;
    align-items: flex-end;
    justify-content: center;
    z-index: 90;
    outline: none;
  }
  .more-overlay.open { display: flex; }
  .more-sheet {
    width: 100%;
    max-height: 70vh;
    overflow-y: auto;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-bottom: none;
    border-radius: 16px 16px 0 0;
    padding: 8px 8px calc(12px + var(--safe-bottom));
    box-shadow: 0 -12px 40px rgba(0,0,0,0.5);
  }
  .more-sheet-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255,255,255,0.5);
    padding: 14px 14px 6px;
  }
  .more-sheet-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 14px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .more-sheet-item:hover, .more-sheet-item:active { background: rgba(255,255,255,0.08); }
  .more-sheet-item.active { color: #e5a00d; }
  .more-sheet-item-icon { width: 22px; height: 22px; flex: none; display: flex; align-items: center; justify-content: center; }
  .more-sheet-item-icon svg { width: 20px; height: 20px; }
  .more-sheet-item-icon img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
  .more-sheet-cancel {
    width: 100%;
    padding: 13px;
    margin-top: 4px;
    border-radius: 10px;
    border: none;
    background: transparent;
    color: rgba(255,255,255,0.55);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .more-sheet-cancel:hover { color: #fff; }
  .title-info-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.8);
    backdrop-filter: blur(6px);
    display: none;
    align-items: flex-start;
    justify-content: center;
    z-index: 200;
    outline: none;
    overflow-y: auto;
    padding: 40px 20px;
  }
  .title-info-overlay.open { display: flex; }
  .title-info-modal {
    width: 780px;
    max-width: 100%;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
    overflow: hidden;
    position: relative;
  }
  .title-info-modal::before {
    content: "";
    position: absolute;
    inset: -30px;
    background-image: var(--title-info-bg, none);
    background-size: cover;
    background-position: center;
    filter: blur(50px) brightness(0.35) saturate(1.1);
    z-index: 0;
  }
  .title-info-close {
    position: absolute; top: 14px; right: 14px; z-index: 2;
    width: 34px; height: 34px; border-radius: 50%; border: none;
    background: rgba(20,20,20,0.7); color: #fff; font-size: 15px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .title-info-close:hover { background: rgba(20,20,20,0.9); }
  .title-info-art {
    width: 100%; height: 280px; background-size: cover; background-position: center;
    position: relative; z-index: 1; background-color: #0d0d0f;
  }
  .title-info-art::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(22,22,25,0) 40%, #161619 100%);
  }
  .title-info-progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 4px; z-index: 2;
    background: rgba(255,255,255,0.25);
  }
  .title-info-progress[hidden] { display: none; }
  .title-info-progress .bar { height: 100%; background: #e5a00d; }
  .title-info-body { padding: 0 32px 32px; margin-top: -64px; position: relative; z-index: 1; }
  .title-info-title { font-size: 26px; font-weight: 800; margin-bottom: 8px; }
  .title-info-meta { font-size: 13px; color: rgba(255,255,255,0.65); margin-bottom: 18px; }
  .title-info-meta span:not(:last-child)::after { content: "•"; margin-left: 10px; color: rgba(255,255,255,0.3); }
  .title-info-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .title-info-play {
    border: none; border-radius: 8px; padding: 11px 26px; font-size: 14px; font-weight: 700;
    cursor: pointer; background: #fff; color: #161619;
  }
  .title-info-play:hover { background: rgba(255,255,255,0.85); }
  .title-info-watchlist-btn {
    width: 40px; height: 40px; border-radius: 50%; flex: none;
    border: 1px solid rgba(255,255,255,0.3); background: transparent; color: #fff;
    font-size: 17px; cursor: pointer;
  }
  .title-info-watchlist-btn:hover { background: rgba(255,255,255,0.1); }
  .title-info-watchlist-btn[hidden] { display: none; }
  .title-info-quality-btn {
    width: 40px; height: 40px; border-radius: 50%; flex: none;
    border: 1px solid rgba(255,255,255,0.3); background: transparent; color: #fff;
    font-size: 16px; cursor: pointer;
  }
  .title-info-quality-btn:hover { background: rgba(255,255,255,0.1); }
  .title-info-quality-btn[hidden] { display: none; }
  /* z-index above .title-info-overlay (200), same relationship .pin-overlay (110) has
     to .profile-overlay (100) - this is launched from within the title-info modal. */
  .quality-picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.72);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center;
    justify-content: center;
    padding: calc(20px + var(--safe-top)) 20px calc(20px + var(--safe-bottom));
    z-index: 210;
    outline: none;
  }
  .quality-picker-overlay.open { display: flex; }
  .quality-picker-modal {
    width: 340px;
    max-width: 88vw;
    max-height: 80vh;
    overflow-y: auto;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  }
  .quality-picker-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; text-align: center; }
  .quality-picker-section-title {
    font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.5);
    text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px;
  }
  .quality-picker-option {
    display: block; width: 100%; background: rgba(255,255,255,0.05); border: none;
    border-radius: 8px; padding: 10px 12px; color: #fff; font-size: 13px;
    text-align: left; cursor: pointer; margin-bottom: 6px;
  }
  .quality-picker-option:hover { background: rgba(255,255,255,0.1); }
  .quality-picker-option.selected { background: rgba(229,160,13,0.15); color: #e5a00d; }
  .quality-picker-done {
    width: 100%; padding: 10px; margin-top: 8px; border-radius: 8px; border: none;
    background: #fff; color: #161619; font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .quality-picker-done:hover { background: rgba(255,255,255,0.85); }
  .title-info-summary { font-size: 14px; line-height: 1.6; color: rgba(255,255,255,0.85); margin-bottom: 22px; max-width: 640px; }
  .title-info-section-title { font-size: 14px; font-weight: 700; margin: 22px 0 10px; }
  .title-info-cast-wrap[hidden], .title-info-similar-wrap[hidden] { display: none; }
  .title-info-cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 14px; }
  .title-info-cast-chip { display: flex; flex-direction: column; align-items: center; text-align: center; }
  .title-info-cast-avatar {
    position: relative; width: 56px; height: 56px; border-radius: 50%; overflow: hidden; margin-bottom: 6px;
    background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center;
  }
  .title-info-cast-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .title-info-cast-avatar-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.45); }
  .title-info-cast-avatar-fallback svg { width: 28px; height: 28px; }
  .title-info-cast-name { font-size: 12px; color: rgba(255,255,255,0.85); line-height: 1.3; }
  .title-info-cast-role { font-size: 11px; color: rgba(255,255,255,0.5); line-height: 1.3; }
  .title-info-season-select {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #fff;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px;
  }
  .title-info-episode { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; }
  .title-info-episode.current { background: rgba(229,160,13,0.08); border-radius: 8px; padding-left: 8px; margin-left: -8px; padding-right: 8px; margin-right: -8px; }
  .title-info-episode-thumb {
    position: relative; width: 140px; height: 79px; border-radius: 6px; flex: none;
    background: rgba(255,255,255,0.05); overflow: hidden;
  }
  .title-info-episode-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .title-info-episode-progress {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,0.3);
  }
  .title-info-episode-progress .bar { height: 100%; background: #e5a00d; }
  .title-info-episode-watched {
    position: absolute; top: 4px; left: 4px; width: 18px; height: 18px; border-radius: 50%;
    background: rgba(20,20,24,0.7); color: #e5a00d; display: flex; align-items: center; justify-content: center;
  }
  .title-info-episode-watched svg { width: 11px; height: 11px; }
  .title-info-episode-play {
    position: absolute; inset: 0; z-index: 2;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity 0.15s ease;
  }
  .title-info-episode:hover .title-info-episode-play,
  .title-info-episode:focus-visible .title-info-episode-play { opacity: 1; }
  .title-info-episode-play-icon {
    width: 34px; height: 34px; border-radius: 50%;
    background: rgba(255,255,255,0.9); color: #161619;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px;
  }
  .title-info-episode-title { font-size: 13.5px; font-weight: 700; margin-bottom: 4px; }
  .title-info-episode-summary { font-size: 12.5px; color: rgba(255,255,255,0.6); line-height: 1.4; }
  .title-info-loading { padding: 20px 0; color: rgba(255,255,255,0.5); font-size: 13px; }
  .title-info-similar { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
  .title-info-similar-item { cursor: pointer; }
  .title-info-similar-item img { width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 6px; background: rgba(255,255,255,0.05); display: block; }
  .title-info-similar-item .t { font-size: 11.5px; margin-top: 6px; color: rgba(255,255,255,0.75); }
  /* One shared focus ring for every element focus-nav.js makes navigable - this app was
     mouse/hover-only until Xbox needed D-pad support, so unlike normal web focus styling
     (a nice-to-have for keyboard users alongside a mouse), a visible focus indicator here
     is the *only* signal a gamepad-only user has of where they are on screen at all. */
  .nav-item:focus-visible,
  .poster:focus-visible,
  .hero-info-btn:focus-visible,
  .hero-watchlist-btn:focus-visible,
  .hero-mute-btn:focus-visible,
  .hero-play-btn:focus-visible,
  .scroll-arrow:focus-visible,
  .pin-key:focus-visible,
  .pin-cancel:focus-visible,
  .profile-switch-btn:focus-visible,
  .profile-cancel:focus-visible,
  .title-info-close:focus-visible,
  .title-info-play:focus-visible,
  .title-info-watchlist-btn:focus-visible,
  .title-info-quality-btn:focus-visible,
  .title-info-episode:focus-visible,
  .title-info-similar-item:focus-visible,
  .title-info-season-select:focus-visible,
  .quality-picker-option:focus-visible,
  .quality-picker-done:focus-visible,
  .more-sheet-item:focus-visible,
  .more-sheet-cancel:focus-visible {
    outline: 2px solid #e5a00d;
    outline-offset: 2px;
  }
  .nav-item { outline-offset: -2px; }
  @media (max-width: 700px) {
    .title-info-overlay { padding: 0; }
    .title-info-modal { width: 100%; max-width: 100%; min-height: 100dvh; border-radius: 0; border: none; }
    .title-info-close { display: none; }
    .title-info-body { padding-bottom: calc(32px + var(--safe-bottom)); }
    .hero-info { left: 20px; max-width: calc(100% - 40px); }
    .hero-title { font-size: 24px; }
    .hero-subtitle { font-size: 13px; }
    .hero-summary { display: none; }
    .sidenav {
      position: fixed;
      top: auto;
      bottom: 0;
      left: 0;
      right: 0;
      width: 100%;
      height: calc(56px + var(--safe-bottom));
      flex-direction: row;
      align-items: center;
      justify-content: space-evenly;
      padding: 0;
      padding-bottom: var(--safe-bottom);
      gap: 0;
      border-right: none;
      border-top: 1px solid rgba(255,255,255,0.08);
      background: rgba(10,10,12,0.97);
      backdrop-filter: blur(10px);
      z-index: 25;
    }
    .sidenav:hover { flex-basis: 100%; }
    .nav-top, .nav-bottom { display: contents; }
    .nav-item { width: 30px; height: 30px; padding: 0; justify-content: center; gap: 0; }
    .nav-label { display: none; }
    /* Profile/Kids Mode/Settings and any library tab past the mobile cap move into the
       .more-sheet overflow menu instead - a phone-width row has no room for 6+ icons at
       a real touch-target size. */
    .nav-profile, .nav-kids-toggle, .nav-settings, .nav-item-overflow { display: none; }
    .nav-more { display: flex; }
    .main { padding-bottom: calc(56px + var(--safe-bottom)); }
    .row-title { padding-left: 24px; }
    .row-scroller { padding-left: 24px; gap: 17px; }
    .poster { flex-basis: 112px; }
    .poster .glow { inset: -10px; filter: blur(14px) saturate(1.2) brightness(0.7); border-radius: 15px; }
    .poster .caption { padding: 88px 8px 8px; }
    .poster.landscape { flex-basis: 224px; }
    .poster.landscape .caption { padding: 42px 8px 8px; }
    .rank-number { font-size: 182px; letter-spacing: -10px; left: -4px; }
    .rank-item .poster { margin-left: 63px; }
    .search-page-group { padding: 0 16px; }
    .search-page-back { padding: 0 16px 20px; }
    .search-page-grid { gap: 17px; }
    .search-page-grid .poster { flex: 0 0 calc((100% - 34px) / 3); }
  }
`;

/* type here matches settings.js's SECTION_TYPE_MAP (1 = movie, 2 = show) - the
   numeric convention persisted in config.sections. */
const SECTION_TYPE_FILTERS = {
  1: { onDeck: "movie", other: "movie" },
  2: { onDeck: "episode", other: "show" },
};

/* How many library tabs stay directly on the mobile bottom nav bar before the rest
   spill into the "More" overflow sheet alongside Profile/Kids Mode/Settings - desktop's
   hover sidenav has room for all of them regardless, see .nav-item-overflow. */
const MOBILE_VISIBLE_SECTION_CAP = 3;

const MOVIE_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="8" width="4" height="1.6" fill="currentColor"/><rect x="3" y="13" width="4" height="1.6" fill="currentColor"/><rect x="17" y="8" width="4" height="1.6" fill="currentColor"/><rect x="17" y="13" width="4" height="1.6" fill="currentColor"/></svg>';
const TV_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" stroke-width="1.6"/></svg>';
const GENERIC_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="3.2" rx="1.2" fill="currentColor"/><rect x="3" y="10.4" width="18" height="3.2" rx="1.2" fill="currentColor"/><rect x="3" y="15.8" width="18" height="3.2" rx="1.2" fill="currentColor"/></svg>';
/* Best-effort icon-by-name for a fetched library's own label (freely user-edited in
   Settings) - falls back to a generic library icon rather than guessing from the
   section's movie/show type, since a "Kids" or "Anime" library shouldn't just get
   whichever of the two hand-drawn icons happens to match its underlying Plex type. */
const NAV_ICON_NAME_RULES = [
  { test: /movie|film|cinema/i, icon: MOVIE_NAV_ICON_SVG },
  { test: /tv|show|series|anime/i, icon: TV_NAV_ICON_SVG },
];
function iconForLibraryLabel(label) {
  const rule = NAV_ICON_NAME_RULES.find((r) => r.test.test(label || ""));
  return rule ? rule.icon : GENERIC_NAV_ICON_SVG;
}

const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CLEAR_ICON_SVG =
  '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const PROFILE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const MORE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
const POSTER_FALLBACK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="5.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.4" cy="9.3" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.4" cy="14.7" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="6.6" cy="14.7" r="1.3" fill="currentColor" stroke="none"/><circle cx="6.6" cy="9.3" r="1.3" fill="currentColor" stroke="none"/></svg>';

const EMPTY_STATE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="10.5" cy="10.5" r="7"/><path d="M20 20l-4.8-4.8" stroke-linecap="round"/></svg>';
const WATCHED_ICON_SVG =
  '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Plex's /hubs/search `reason` field marks a match as coming from a specific
   person/entity rather than a plain title hit - only these two are confirmed
   to actually appear in practice, so only these get promoted to their own section. */
/* kbps: null means "no cap" (Original) - matched against _titleInfoQualityCapKbps by
   identity in _renderQualityPicker, so keep it null rather than 0 or a sentinel number. */
const QUALITY_CAP_PRESETS = [
  { label: "Original", kbps: null },
  { label: "1080p (20 Mbps)", kbps: 20000 },
  { label: "720p (10 Mbps)", kbps: 10000 },
  { label: "480p (4 Mbps)", kbps: 4000 },
  { label: "360p (2 Mbps)", kbps: 2000 },
];
const SEARCH_REASON_LABELS = { actor: "Actor", director: "Director" };
const SEARCH_HUB_LIMIT = 24;
/* "See All" section expansion - large enough that no single library section's
   search hub is likely to actually hit this ceiling. */
const SEARCH_EXPAND_LIMIT = 500;

class PlexNetflixCard extends HTMLElement {
  /* No required fields here, unlike the original HA-card version - this can be called
     with an empty/partial config (e.g. first run, nothing in Settings yet) and just
     renders a "go configure me" message from _loadAll() below instead of throwing. */
  setConfig(config) {
    this._config = {
      max_genre_rows: 12,
      collection_row_count: 2,
      row_size: 20,
      sections: [],
      title: "Streaming",
      landscape_every_nth: 4,
      /* Required to turn Kids Mode back OFF (turning it on is never gated). */
      kids_mode_pin: "1233",
      /* Ratings at/under a PG-equivalent - anything else (or unrated/missing) is hidden
         in Kids Mode. TV-PG is the closest TV-scale equivalent to a movie PG rating. */
      kids_mode_allowed_ratings: ["G", "PG", "TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "TV-PG"],
      /* Hidden in Kids Mode regardless of content rating - horror was the explicit ask;
         war/thriller are included as a reasonable default extension, adjust freely. */
      kids_mode_blocked_genres: ["Horror", "War", "Thriller"],
      ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
      ...config,
    };
    if (!this._built) {
      this._build();
      this._built = true;
    } else {
      this._renderNavSections();
    }
  }

  /* Public entry point for Settings modal saves (see app.js) - re-merges config and
     re-runs the full load, since _loadAll() otherwise only ever fires once per
     connectedCallback (see _loaded guard there). */
  refreshConfig(config) {
    this.setConfig(config);
    this._loaded = true;
    this._loadAll();
  }

  /* True unless Kids Mode is on and this raw Plex metadata item (has .contentRating /
     .Genre, same shape everywhere in this file before _mapItem strips it down) fails
     the rating or genre check. Used as the single filter predicate everywhere raw items
     become candidates for display: genre rows, AI rows, hero picks, search, etc. */
  _passesKidsMode(m) {
    if (!this._kidsMode || !m) return true;
    const genres = (m.Genre || []).map((g) => (g.tag || "").trim().toLowerCase());
    const blocked = this._config.kids_mode_blocked_genres || [];
    if (blocked.some((bg) => genres.includes(bg.trim().toLowerCase()))) return false;
    const rating = (m.contentRating || "").trim().toUpperCase();
    const allowed = this._config.kids_mode_allowed_ratings || [];
    return allowed.map((r) => r.toUpperCase()).includes(rating);
  }

  /* Whole-row genre blocking, separate from _passesKidsMode's per-item Genre check.
     Plex's list endpoints (genre listing, /all?genre=) truncate each item's own Genre
     array to ~2 tags, so plenty of titles filed under e.g. Horror don't actually show
     "Horror" in their own truncated tag list (confirmed empirically: "The Conjuring:
     The Devil Made Me Do It" returns Genre [Thriller, Mystery], no Horror). A row built
     directly from a genre fetch is unambiguously that genre regardless of what its
     items' own tags say - checking the row's own genre name here is what actually keeps
     a "Horror" row from appearing at all in Kids Mode. */
  _isBlockedGenreName(name) {
    if (!this._kidsMode) return false;
    const blocked = this._config.kids_mode_blocked_genres || [];
    const norm = (name || "").trim().toLowerCase();
    return blocked.some((bg) => bg.trim().toLowerCase() === norm);
  }

  _onKidsModeChanged() {
    this._kidsToggleBtn?.classList.toggle("active", this._kidsMode);
    if (!this._loaded) return;
    /* Cached per-view genre/AI row shuffle needs to re-filter, not just re-shuffle. */
    this._genreRowsCache = {};
    if (this._currentView === "search") {
      if (this._lastSearchHubs) this._renderSearchPage(this._lastSearchHubs);
    } else {
      this._renderCurrentView();
      this._advanceHero();
    }
  }

  /* Custom numeric-keypad modal replacing window.prompt/alert for PIN entry - this card
     has no native browser-dialog usage elsewhere, and a Netflix-style kiosk dashboard
     (often touch/TV, no physical keyboard) needs a tappable keypad rather than an OS
     text-input dialog. Shared by Kids Mode's exit gate and the Plex profile switcher's
     PIN prompt (see _verifyKidsPin/_switchToUser) rather than each owning its own copy.
     Resolves with the entered digit string once `length` digits are typed, or null if
     cancelled - checking those digits against anything is the caller's job, not this
     modal's, since Kids Mode verifies locally but a Plex profile PIN can only be
     verified by Plex itself. */
  _promptForDigits(length, title) {
    return new Promise((resolve) => {
      this._pinResolve = resolve;
      this._pinEntry = "";
      this._pinLength = length;
      this._pinTitleEl.textContent = title;
      this._pinError.classList.remove("visible");
      this._pinModal.classList.remove("shake");
      this._renderPinDots();
      this._pinOverlay.classList.add("open");
      this.shadowRoot.querySelector(".pin-key[data-digit]")?.focus();
    });
  }

  _resolvePin(result) {
    this._pinOverlay.classList.remove("open");
    const resolve = this._pinResolve;
    this._pinResolve = null;
    if (resolve) resolve(result);
  }

  _renderPinDots() {
    const pinLength = this._pinLength || 4;
    if (this._pinDots.children.length !== pinLength) {
      this._pinDots.innerHTML = Array.from({ length: pinLength }, () => '<span class="pin-dot"></span>').join("");
    }
    [...this._pinDots.children].forEach((dot, i) => dot.classList.toggle("filled", i < this._pinEntry.length));
  }

  /* Wrong-PIN feedback (shake + clear) without closing the modal - used by Kids Mode's
     retry loop below. The profile switcher doesn't use this: a wrong Plex PIN is a
     server round-trip away, not a local comparison, so it just reports the error and
     lets the user press "Switch" again rather than auto-retrying. */
  _shakePinEntry() {
    this._pinError.classList.add("visible");
    this._pinModal.classList.remove("shake");
    void this._pinModal.offsetWidth;
    this._pinModal.classList.add("shake");
    this._pinEntry = "";
    this._renderPinDots();
  }

  /* Loops the shared PIN prompt until the Kids Mode PIN matches or the user cancels -
     this is where the "compare against kids_mode_pin" logic that used to live inside
     the keypad modal itself now lives, since the modal is generic. */
  async _verifyKidsPin() {
    const expected = String(this._config.kids_mode_pin || "");
    for (;;) {
      const entry = await this._promptForDigits(expected.length || 4, "Enter PIN to Exit Kids Mode");
      if (entry === null) return false;
      if (entry === expected) return true;
      this._shakePinEntry();
    }
  }

  getCardSize() {
    return 12;
  }

  connectedCallback() {
    if (!this._loaded) {
      this._loaded = true;
      this._loadAll();
    }
  }

  _build() {
    this._currentView = "home";
    this._lastSearchQuery = null;
    this._lastSearchHubs = null;
    /* Purely local now (localStorage) - no HA entity backing this, so it's
       per-browser/per-device rather than shared across every screen. */
    this._kidsMode = localStorage.getItem("prism.kidsMode") === "1";
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <nav class="sidenav">
          <div class="nav-top">
            <div class="nav-item active" data-view="home" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="10" y="14" width="4" height="5" fill="currentColor"/></svg></span>
              <span class="nav-label">Home</span>
            </div>
          </div>
          <div class="nav-bottom">
            <div class="nav-item nav-profile" title="Switch Profile" hidden tabindex="0">
              <span class="nav-icon nav-profile-icon"></span>
              <span class="nav-label nav-profile-label">Profile</span>
            </div>
            <div class="nav-item nav-kids-toggle" title="Kids Mode" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.7" cy="10" r="1.15" fill="currentColor"/><circle cx="15.3" cy="10" r="1.15" fill="currentColor"/><path d="M8 14.5c1 1.3 2.5 2 4 2s3-0.7 4-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
              <span class="nav-label">Kids Mode</span>
            </div>
            <div class="nav-item nav-settings" title="Settings" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v2.4M12 18.1v2.4M4.5 12H6.9M17.1 12h2.4M6.3 6.3l1.7 1.7M16 16l1.7 1.7M17.7 6.3 16 8M8 16l-1.7 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
              <span class="nav-label">Settings</span>
            </div>
            <div class="nav-item nav-more" title="More" tabindex="0">
              <span class="nav-icon">${MORE_ICON_SVG}</span>
              <span class="nav-label">More</span>
            </div>
          </div>
        </nav>
        <div class="more-overlay" tabindex="-1">
          <div class="more-sheet">
            <div class="more-sheet-title">More</div>
            <div class="more-sheet-list"></div>
            <button type="button" class="more-sheet-cancel">Cancel</button>
          </div>
        </div>
        <div class="content">
          <div class="header">
            <img class="plex-logo" src="./assets/plex-logo.png" alt="Plex" />
            <div class="search-wrap">
              <button type="button" class="search-toggle"></button>
              <input class="search" type="text" placeholder="Search movies, shows, actors…" autocomplete="off" />
            </div>
          </div>
          <div class="main">
            <div class="hero">
              <div class="hero-media hero-media-a"></div>
              <div class="hero-media hero-media-b"></div>
              <div class="hero-fade"></div>
              <div class="hero-info">
                <div class="hero-title"></div>
                <div class="hero-subtitle"></div>
                <div class="hero-summary"></div>
                <div class="hero-buttons">
                  <button type="button" class="hero-info-btn">More Info</button>
                  <button type="button" class="hero-watchlist-btn" aria-label="Add to My List">+</button>
                </div>
              </div>
              <button type="button" class="hero-play-btn" aria-label="Play/pause">⏸</button>
              <button type="button" class="hero-mute-btn" aria-label="Toggle sound">🔊</button>
            </div>
            <div class="rows"></div>
          </div>
        </div>
      </div>
      <div class="pin-overlay" tabindex="-1">
        <div class="pin-modal">
          <div class="pin-icon">
            <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </div>
          <div class="pin-title">Enter PIN</div>
          <div class="pin-dots"></div>
          <div class="pin-error">Incorrect PIN</div>
          <div class="pin-keypad">
            <button type="button" class="pin-key" data-digit="1">1</button>
            <button type="button" class="pin-key" data-digit="2">2</button>
            <button type="button" class="pin-key" data-digit="3">3</button>
            <button type="button" class="pin-key" data-digit="4">4</button>
            <button type="button" class="pin-key" data-digit="5">5</button>
            <button type="button" class="pin-key" data-digit="6">6</button>
            <button type="button" class="pin-key" data-digit="7">7</button>
            <button type="button" class="pin-key" data-digit="8">8</button>
            <button type="button" class="pin-key" data-digit="9">9</button>
            <button type="button" class="pin-key pin-key-empty" tabindex="-1"></button>
            <button type="button" class="pin-key" data-digit="0">0</button>
            <button type="button" class="pin-key pin-backspace" aria-label="Backspace">⌫</button>
          </div>
          <button type="button" class="pin-cancel">Cancel</button>
        </div>
      </div>
      <div class="profile-overlay" tabindex="-1">
        <div class="profile-modal">
          <div class="profile-title">Switch Profile</div>
          <div class="profile-list"></div>
          <button type="button" class="profile-cancel">Cancel</button>
        </div>
      </div>
      <div class="title-info-overlay" tabindex="-1">
        <div class="title-info-modal">
          <button type="button" class="title-info-close" aria-label="Close">✕</button>
          <div class="title-info-art">
            <div class="title-info-progress" hidden><div class="bar"></div></div>
          </div>
          <div class="title-info-body">
            <div class="title-info-title"></div>
            <div class="title-info-meta"></div>
            <div class="title-info-actions">
              <button type="button" class="title-info-play">▶ Play</button>
              <button type="button" class="title-info-watchlist-btn" aria-label="Add to My List">+</button>
              <button type="button" class="title-info-quality-btn" aria-label="Quality" hidden>⚙</button>
            </div>
            <div class="title-info-summary"></div>
            <div class="title-info-episodes"></div>
            <div class="title-info-cast-wrap" hidden>
              <div class="title-info-section-title">Cast</div>
              <div class="title-info-cast"></div>
            </div>
            <div class="title-info-similar-wrap" hidden>
              <div class="title-info-section-title">More Like This</div>
              <div class="title-info-similar"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="quality-picker-overlay" tabindex="-1">
        <div class="quality-picker-modal">
          <div class="quality-picker-title">Quality</div>
          <div class="quality-picker-section-title">Version</div>
          <div class="quality-picker-versions"></div>
          <div class="quality-picker-section-title">Quality Cap</div>
          <div class="quality-picker-caps"></div>
          <button type="button" class="quality-picker-done">Done</button>
        </div>
      </div>
    `;
    this._rowsEl = this.shadowRoot.querySelector(".rows");
    this._searchWrap = this.shadowRoot.querySelector(".search-wrap");
    this._searchToggle = this.shadowRoot.querySelector(".search-toggle");
    this._searchInput = this.shadowRoot.querySelector(".search");
    this._renderNavSections();
    this._kidsToggleBtn = this.shadowRoot.querySelector(".nav-kids-toggle");
    this._settingsBtn = this.shadowRoot.querySelector(".nav-settings");
    this._profileNavItem = this.shadowRoot.querySelector(".nav-profile");
    this._profileNavIcon = this.shadowRoot.querySelector(".nav-profile-icon");
    this._profileNavLabel = this.shadowRoot.querySelector(".nav-profile-label");
    this._profileOverlay = this.shadowRoot.querySelector(".profile-overlay");
    this._profileListEl = this.shadowRoot.querySelector(".profile-list");
    this._profileCancelBtn = this.shadowRoot.querySelector(".profile-cancel");
    this._moreBtn = this.shadowRoot.querySelector(".nav-more");
    this._moreOverlay = this.shadowRoot.querySelector(".more-overlay");
    this._moreListEl = this.shadowRoot.querySelector(".more-sheet-list");
    this._moreCancelBtn = this.shadowRoot.querySelector(".more-sheet-cancel");
    this._pinOverlay = this.shadowRoot.querySelector(".pin-overlay");
    this._pinModal = this.shadowRoot.querySelector(".pin-modal");
    this._pinTitleEl = this.shadowRoot.querySelector(".pin-title");
    this._pinDots = this.shadowRoot.querySelector(".pin-dots");
    this._pinError = this.shadowRoot.querySelector(".pin-error");
    this._pinCancelBtn = this.shadowRoot.querySelector(".pin-cancel");
    this._titleInfoOverlay = this.shadowRoot.querySelector(".title-info-overlay");
    this._titleInfoModal = this.shadowRoot.querySelector(".title-info-modal");
    this._titleInfoCloseBtn = this.shadowRoot.querySelector(".title-info-close");
    this._titleInfoArt = this.shadowRoot.querySelector(".title-info-art");
    this._titleInfoProgress = this.shadowRoot.querySelector(".title-info-progress");
    this._titleInfoProgressBar = this._titleInfoProgress.querySelector(".bar");
    this._titleInfoTitleEl = this.shadowRoot.querySelector(".title-info-title");
    this._titleInfoMetaEl = this.shadowRoot.querySelector(".title-info-meta");
    this._titleInfoPlayBtn = this.shadowRoot.querySelector(".title-info-play");
    this._titleInfoWatchlistBtn = this.shadowRoot.querySelector(".title-info-watchlist-btn");
    this._titleInfoQualityBtn = this.shadowRoot.querySelector(".title-info-quality-btn");
    this._qualityPickerOverlay = this.shadowRoot.querySelector(".quality-picker-overlay");
    this._qualityPickerVersionsEl = this.shadowRoot.querySelector(".quality-picker-versions");
    this._qualityPickerCapsEl = this.shadowRoot.querySelector(".quality-picker-caps");
    this._qualityPickerDoneBtn = this.shadowRoot.querySelector(".quality-picker-done");
    this._titleInfoSummaryEl = this.shadowRoot.querySelector(".title-info-summary");
    this._titleInfoEpisodesEl = this.shadowRoot.querySelector(".title-info-episodes");
    this._titleInfoCastWrap = this.shadowRoot.querySelector(".title-info-cast-wrap");
    this._titleInfoCastEl = this.shadowRoot.querySelector(".title-info-cast");
    this._titleInfoSimilarWrap = this.shadowRoot.querySelector(".title-info-similar-wrap");
    this._titleInfoSimilarEl = this.shadowRoot.querySelector(".title-info-similar");
    this._heroEl = this.shadowRoot.querySelector(".hero");
    this._heroMediaLayers = [
      this.shadowRoot.querySelector(".hero-media-a"),
      this.shadowRoot.querySelector(".hero-media-b"),
    ];
    this._heroActiveLayer = 0;
    this._heroTitleEl = this.shadowRoot.querySelector(".hero-title");
    this._heroSubtitleEl = this.shadowRoot.querySelector(".hero-subtitle");
    this._heroSummaryEl = this.shadowRoot.querySelector(".hero-summary");
    this._heroInfoBtn = this.shadowRoot.querySelector(".hero-info-btn");
    this._heroWatchlistBtn = this.shadowRoot.querySelector(".hero-watchlist-btn");
    this._heroMuteBtn = this.shadowRoot.querySelector(".hero-mute-btn");
    this._heroPlayBtn = this.shadowRoot.querySelector(".hero-play-btn");
    /* Caps how many times _resolveHeroVideo will actually attempt a trailer (Plex
       extras fetch or YouTube search) per page load. Left running unattended, each
       hero auto-advance triggers a fresh trailer lookup, and YouTube's search
       endpoint is quota-limited (100/day) - after this many attempts, later
       advances just show the static backdrop image instead of burning more quota. */
    this._heroTrailerResolveCap = 5;
    this._heroTrailerResolveCount = 0;
    this._heroMuted = false;
    /* _heroUserPaused is the user's explicit intent, independent of why playback is
       actually stopped right now (window unfocused / hero scrolled out of view). Actual
       playback is always the AND of "user hasn't paused" and "tab focused + hero
       visible" - see _heroShouldPlay/_updateHeroPlayback below. */
    this._heroUserPaused = false;
    this._heroInView = true;
    /* Track focus via events rather than polling document.hasFocus() directly - the HA
       Companion app's Android WebView never grants the page native input focus (no
       tappable field has been focused), so hasFocus() reads false forever there even
       though the app is genuinely in the foreground. Defaulting true and only flipping
       on a real blur event keeps focus-based pausing working on desktop browsers
       without permanently blocking playback in the companion app. */
    this._heroWindowFocused = true;
    /* Same reasoning as _heroWindowFocused above, applied to Page Visibility: some
       WebViews (again including the Companion app's) never fire/track this correctly
       and document.visibilityState can read "hidden" forever even while genuinely
       onscreen. Track it via the event instead of polling the live property. */
    this._heroPageVisible = true;

    this._heroInfoBtn.addEventListener("click", () => {
      if (!this._heroItem) return;
      this._openTitleInfo(this._mapItem(this._heroItem, false), "local");
    });
    this._heroWatchlistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this._heroItem) return;
      if (this._heroWatchlistBtn.classList.contains("added")) {
        this._removeFromWatchlist(this._heroItem, this._heroWatchlistBtn);
      } else {
        this._addToWatchlist(this._heroItem, this._heroWatchlistBtn);
      }
    });
    this._heroWatchlistBtn.addEventListener("mouseenter", () => {
      if (this._heroWatchlistBtn.classList.contains("added")) this._heroWatchlistBtn.textContent = "−";
    });
    this._heroWatchlistBtn.addEventListener("mouseleave", () => {
      if (this._heroWatchlistBtn.classList.contains("added")) this._heroWatchlistBtn.textContent = "✓";
    });
    this._heroMuteBtn.addEventListener("click", () => {
      this._heroMuted = !this._heroMuted;
      this._heroMuteBtn.textContent = this._heroMuted ? "🔇" : "🔊";
      const activeMedia = this._heroMediaLayers[this._heroActiveLayer];
      const video = activeMedia.querySelector("video");
      if (video) video.muted = this._heroMuted;
      const iframe = activeMedia.querySelector("iframe");
      if (iframe) {
        const func = this._heroMuted ? "mute" : "unMute";
        iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
      }
    });
    this._heroPlayBtn.addEventListener("click", () => {
      this._heroUserPaused = !this._heroUserPaused;
      this._updateHeroPlayback();
    });
    /* Auto play/pause: resume only when the tab is focused/visible AND the hero is
       actually scrolled into view, but never override an explicit user pause. */
    this._heroObserver = new IntersectionObserver(
      (entries) => {
        this._heroInView = entries[entries.length - 1].isIntersecting;
        this._updateHeroPlayback();
      },
      { threshold: 0.4 }
    );
    this._heroObserver.observe(this._heroEl);
    window.addEventListener("focus", () => {
      this._heroWindowFocused = true;
      this._updateHeroPlayback();
    });
    window.addEventListener("blur", () => {
      this._heroWindowFocused = false;
      this._updateHeroPlayback();
    });
    document.addEventListener("visibilitychange", () => {
      this._heroPageVisible = document.visibilityState === "visible";
      this._updateHeroPlayback();
    });
    /* The hero trailer has no idea a full-screen video started playing on top of it
       (plex-player.js is a separate module, decoupled from the card - see
       _openTitleInfo/_playTitleInfoItem) - without this it keeps playing, audio and
       all, behind the player. Only restores playback on close if this is what paused
       it - never overrides a pause the user set themselves via the hero's own button. */
    window.addEventListener("streaming-player-open", () => {
      if (!this._heroUserPaused) {
        this._heroUserPaused = true;
        this._heroPausedByPlayer = true;
        this._updateHeroPlayback();
      }
    });
    window.addEventListener("streaming-player-close", () => {
      if (this._heroPausedByPlayer) {
        this._heroPausedByPlayer = false;
        this._heroUserPaused = false;
        this._updateHeroPlayback();
      }
    });
    /* YouTube's embed only starts posting "infoDelivery" state updates (playerState 0 =
       ended) after it receives a "listening" handshake - sent once the iframe loads, see
       _showHero below. No official iframe_api script is loaded, so this raw postMessage
       protocol is the only way to detect trailer-end without it. */
    window.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (data.event === "infoDelivery" && data.info && data.info.playerState === 0) {
        this._advanceHero();
      }
    });

    /* Dynamic (per-library) nav items are already wired inside _renderNavSections,
       called above - only Home is static and needs wiring here. */
    this._wireNavItem(this.shadowRoot.querySelector('.nav-item[data-view="home"]'));

    this._kidsToggleBtn.addEventListener("click", async () => {
      /* Only exiting Kids Mode is PIN-gated - turning it on is always allowed. */
      if (this._kidsMode && this._config.kids_mode_pin) {
        const ok = await this._verifyKidsPin();
        if (!ok) return;
      }
      this._kidsMode = !this._kidsMode;
      localStorage.setItem("prism.kidsMode", this._kidsMode ? "1" : "0");
      this._onKidsModeChanged();
    });

    this._settingsBtn.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("open-settings", { bubbles: true, composed: true }));
    });

    this._profileNavItem.addEventListener("click", () => this._openProfileOverlay());
    this._profileCancelBtn.addEventListener("click", () => this._closeProfileOverlay());
    this._profileOverlay.addEventListener("click", (e) => {
      if (e.target === this._profileOverlay) this._closeProfileOverlay();
    });
    this._profileNav = wireLinearNav(this.shadowRoot, ".profile-switch-btn, .profile-cancel", {
      orientation: "vertical",
      onBack: () => this._closeProfileOverlay(),
    });

    this._moreBtn.addEventListener("click", () => this._openMoreSheet());
    this._moreCancelBtn.addEventListener("click", () => this._closeMoreSheet());
    this._moreOverlay.addEventListener("click", (e) => {
      if (e.target === this._moreOverlay) this._closeMoreSheet();
    });
    this._moreNav = wireLinearNav(this.shadowRoot, ".more-sheet-item, .more-sheet-cancel", {
      orientation: "vertical",
      onBack: () => this._closeMoreSheet(),
    });

    this._titleInfoCloseBtn.addEventListener("click", () => this._closeTitleInfo());
    this._titleInfoOverlay.addEventListener("click", (e) => {
      if (e.target === this._titleInfoOverlay) this._closeTitleInfo();
    });
    wireLinearNav(
      this.shadowRoot,
      ".title-info-close, .title-info-play, .title-info-watchlist-btn, .title-info-quality-btn, .title-info-season-select, .title-info-episode, .title-info-similar-item",
      { orientation: "vertical", onBack: () => this._closeTitleInfo() }
    );
    this._titleInfoWatchlistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = this._titleInfoItem;
      if (!item) return;
      if (this._titleInfoWatchlistBtn.classList.contains("added")) {
        this._removeFromWatchlist(item, this._titleInfoWatchlistBtn);
      } else {
        this._addToWatchlist(item, this._titleInfoWatchlistBtn);
      }
    });
    this._titleInfoWatchlistBtn.addEventListener("mouseenter", () => {
      if (this._titleInfoWatchlistBtn.classList.contains("added")) this._titleInfoWatchlistBtn.textContent = "−";
    });
    this._titleInfoWatchlistBtn.addEventListener("mouseleave", () => {
      if (this._titleInfoWatchlistBtn.classList.contains("added")) this._titleInfoWatchlistBtn.textContent = "✓";
    });
    this._titleInfoPlayBtn.addEventListener("click", () => this._playTitleInfoItem());
    this._titleInfoQualityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._openQualityPicker();
    });
    this._qualityPickerOverlay.addEventListener("click", (e) => {
      if (e.target === this._qualityPickerOverlay) this._closeQualityPicker();
    });
    this._qualityPickerDoneBtn.addEventListener("click", () => this._closeQualityPicker());
    wireLinearNav(this.shadowRoot, ".quality-picker-option, .quality-picker-done", {
      orientation: "vertical",
      onBack: () => this._closeQualityPicker(),
    });

    /* Registering a backButton listener at all switches off Capacitor's own default
       Android hardware-back handling (goBack()-if-possible, else exit the app) - without
       this, none of these overlays have a browser history entry to go back to, so every
       one of them just fell straight through to exiting the app. Ordered by overlay
       z-index (highest first) since more than one can theoretically be open at once
       (e.g. quality-picker over title-info). */
    App.addListener("backButton", () => {
      if (this._qualityPickerOverlay.classList.contains("open")) this._closeQualityPicker();
      else if (this._titleInfoOverlay.classList.contains("open")) this._closeTitleInfo();
      else if (this._pinOverlay.classList.contains("open")) this._resolvePin(null);
      else if (this._profileOverlay.classList.contains("open")) this._closeProfileOverlay();
      else if (this._moreOverlay.classList.contains("open")) this._closeMoreSheet();
      else App.exitApp();
    });

    this._pinEntry = "";
    const pressPinDigit = (digit) => {
      const length = this._pinLength || 4;
      if (this._pinEntry.length >= length) return;
      this._pinEntry += digit;
      this._renderPinDots();
      if (this._pinEntry.length === length) this._resolvePin(this._pinEntry);
    };
    const pressPinBackspace = () => {
      this._pinEntry = this._pinEntry.slice(0, -1);
      this._pinError.classList.remove("visible");
      this._renderPinDots();
    };
    this.shadowRoot.querySelectorAll(".pin-key[data-digit]").forEach((btn) => {
      btn.addEventListener("click", () => pressPinDigit(btn.dataset.digit));
    });
    this.shadowRoot.querySelector(".pin-backspace").addEventListener("click", pressPinBackspace);
    this._pinCancelBtn.addEventListener("click", () => this._resolvePin(null));
    this._pinOverlay.addEventListener("click", (e) => {
      if (e.target === this._pinOverlay) this._resolvePin(null);
    });
    this._pinOverlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._resolvePin(null);
      else if (e.key === "Backspace") pressPinBackspace();
      else if (/^[0-9]$/.test(e.key)) pressPinDigit(e.key);
    });
    /* Deliberately not wireLinearNav here - a gamepad has no digit keys, and the keypad's
       3-column grid needs real Left/Right movement within a row, not a single vertical
       list. Row/col math is derived from index against PIN_GRID_COLS rather than reading
       actual pixel layout, since the grid is a fixed 3-column CSS grid. */
    const PIN_GRID_COLS = 3;
    const pinGridKeys = () => Array.from(this.shadowRoot.querySelectorAll(".pin-keypad .pin-key"));
    registerNavHandler((command, e, active) => {
      if (!this._pinOverlay.classList.contains("open")) return false;
      const keys = pinGridKeys();
      const idx = keys.indexOf(active);
      if (idx === -1) {
        if (active !== this._pinCancelBtn) return false;
        if (command === "up") {
          keys[keys.length - 1].focus();
          return true;
        }
        if (command === "activate") {
          active.click();
          return true;
        }
        return false;
      }
      if (command === "activate") {
        active.click();
        return true;
      }
      if (command === "back") {
        this._resolvePin(null);
        return true;
      }
      const row = Math.floor(idx / PIN_GRID_COLS);
      const col = idx % PIN_GRID_COLS;
      let targetIdx;
      if (command === "right") targetIdx = row * PIN_GRID_COLS + Math.min(col + 1, PIN_GRID_COLS - 1);
      else if (command === "left") targetIdx = row * PIN_GRID_COLS + Math.max(col - 1, 0);
      else if (command === "down") targetIdx = idx + PIN_GRID_COLS;
      else if (command === "up") targetIdx = idx - PIN_GRID_COLS;
      else return false;

      if (targetIdx < 0) return true; // nothing above the top row - swallow, don't fall through
      if (targetIdx >= keys.length) {
        // Below the keypad's last row is Cancel, not a dead end.
        this._pinCancelBtn.focus();
        return true;
      }
      /* Grid cell (row 3, col 0) has no real button under it - .pin-key-empty is just a
         layout spacer (tabindex="-1") so "0" (its row-neighbor) is the intended landing
         spot whenever navigation would otherwise land on it. */
      if (targetIdx === 9) targetIdx = 10;
      keys[targetIdx]?.focus();
      return true;
    });

    this._wireHomeNav();

    this._updateSearchToggleIcon();
    this._searchToggle.addEventListener("click", () => {
      if (this._searchInput.value) {
        this._clearSearchInput();
        this._onSearchInput();
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
        return;
      }
      this._searchWrap.classList.add("expanded");
      this._searchInput.focus();
    });
    this._searchInput.addEventListener("focus", () => this._searchWrap.classList.add("expanded"));
    this._searchInput.addEventListener("blur", () => {
      if (this._currentView === "search") return;
      this._searchWrap.classList.remove("expanded");
    });
    this._searchInput.addEventListener("input", () => {
      this._updateSearchToggleIcon();
      this._onSearchInput();
    });
    this._searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this._clearSearchInput();
        this._exitSearch();
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
      }
    });
  }

  _wireNavItem(el) {
    el.addEventListener("click", () => {
      const view = el.dataset.view;
      this._clearSearchInput();
      this._searchWrap.classList.remove("expanded");
      if (view === this._currentView) return;
      this._currentView = view;
      this._navItems.forEach((n) => n.classList.toggle("active", n === el));
      window.scrollTo({ top: 0, behavior: "instant" });
      this._renderCurrentView();
      this._advanceHero();
    });
  }

  /* Renders one nav tab per fetched library (config.sections) instead of fixed
     Movies/TV entries - lets Settings' "Fetch Libraries" list drive the tabs
     directly, so it naturally covers however many/whatever-named libraries the
     server actually has. Re-run on every setConfig() after the initial build (see
     setConfig) so re-fetching/renaming/toggling libraries in Settings updates the
     nav without a full rebuild. Home stays a separate static item since it's the
     fixed "everything combined" view, not tied to any one section. */
  _renderNavSections() {
    const homeItem = this.shadowRoot.querySelector('.nav-item[data-view="home"]');
    this.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => el.remove());
    const sections = this._config.sections || [];
    const html = sections
      .map(
        (s, i) => `
            <div class="nav-item nav-item-dynamic${i >= MOBILE_VISIBLE_SECTION_CAP ? " nav-item-overflow" : ""}" data-view="section-${s.key}" tabindex="0">
              <span class="nav-icon">${iconForLibraryLabel(s.label)}</span>
              <span class="nav-label">${this._escape(s.label)}</span>
            </div>`
      )
      .join("");
    if (html) homeItem.insertAdjacentHTML("afterend", html);
    this._navItems = [...this.shadowRoot.querySelectorAll(".nav-item[data-view]")];
    this.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => this._wireNavItem(el));
    if (this._currentView !== "home" && this._currentView !== "search" && !sections.some((s) => `section-${s.key}` === this._currentView)) {
      this._currentView = "home";
    }
    this._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === this._currentView));
  }

  _clearSearchInput() {
    this._searchInput.value = "";
    this._updateSearchToggleIcon();
  }

  _updateSearchToggleIcon() {
    const hasValue = !!this._searchInput.value;
    this._searchToggle.innerHTML = hasValue ? CLEAR_ICON_SVG : SEARCH_ICON_SVG;
    this._searchToggle.setAttribute("aria-label", hasValue ? "Clear search" : "Search");
  }

  async _plexFetch(path, params = {}) {
    const url = new URL(this._config.plex_url + path);
    Object.entries(params).forEach(([k, v]) => {
      /* Plex ANDs repeated same-key filter params (e.g. two `genre=` keys) rather
         than ORing them - array values let AI-generated multi-genre rows use that. */
      if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, vv));
      else url.searchParams.set(k, v);
    });
    url.searchParams.set("X-Plex-Token", this._config.plex_token);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Plex ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async _loadAll() {
    if (!this._config.plex_url || !this._config.plex_token) {
      this._renderMessage("Open Settings to add your Plex server URL and token.");
      return;
    }
    if (!this._config.sections || !this._config.sections.length) {
      this._renderMessage('Open Settings and click "Fetch Libraries" to choose what to show.');
      return;
    }
    this._renderLoading();
    try {
      const [
        onDeckRaw,
        watchlistRaw,
        recentlyAddedRaw,
        genreBySection,
        searchFacets,
        historyRaw,
        collectionsRaw,
        playlistsRaw,
        homeProfiles,
      ] = await Promise.all([
        this._fetchOnDeckRaw(),
        this._fetchWatchlistRaw(),
        this._fetchRecentlyAddedRaw(),
        this._loadGenreDataBySection(),
        this._loadSearchFacets(),
        this._fetchWatchHistoryRaw(),
        this._fetchCollectionsRaw(),
        this._fetchPlaylistsRaw(),
        this._fetchHomeProfiles(),
      ]);
      this._onDeckRaw = onDeckRaw;
      this._watchlistRaw = watchlistRaw;
      this._recentlyAddedRaw = recentlyAddedRaw;
      this._genreBySection = genreBySection;
      this._genreRowsCache = {};
      this._recommendedRowCache = {};
      this._studioFacets = searchFacets.studios;
      this._collectionFacets = searchFacets.collections;
      this._collectionsRaw = collectionsRaw;
      this._playlistsRaw = playlistsRaw;
      this._homeUsers = homeProfiles.users;
      this._activeUserId = homeProfiles.activeId;
      this._renderProfileNav();
      const rowCount = this._config.collection_row_count ?? 0;
      this._collectionRowPicks = this._shuffle(this._collectionsRaw).slice(0, rowCount);
      this._collectionRowsRaw = await this._fetchCollectionRowItems(this._collectionRowPicks);
      this._recommendedRaw = this._buildRecommendedRaw(historyRaw);
      this._popularRaw = this._buildPopularRaw();
      const aiIdeas = await this._loadAiIdeas();
      this._aiRowsRaw = aiIdeas.length ? await this._fetchAiRowsRaw(aiIdeas) : [];
      this._heroItem = this._pickHeroItem(undefined, this._sectionsForView(this._currentView));
      if (this._heroItem) {
        this._heroVideo = await this._resolveHeroVideo(this._heroItem);
      }
      this._renderCurrentView();
    } catch (err) {
      this._renderMessage(`Couldn't load Plex: ${err.message}`);
    }
  }

  /* "home"/"search" (or any unrecognized view) fall through to null, meaning "no
     single section" - callers treat that as "all sections". */
  _sectionForView(view) {
    if (typeof view !== "string" || !view.startsWith("section-")) return null;
    const key = Number(view.slice("section-".length));
    return (this._config.sections || []).find((s) => s.key === key) || null;
  }

  _sectionsForView(view) {
    const section = this._sectionForView(view);
    return section ? [section] : this._config.sections;
  }

  _shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  _pickHeroItem(excludeKey, sections) {
    const keys = sections ? new Set(sections.map((s) => s.key)) : null;
    const seen = new Map();
    for (const [sectionKey, entries] of this._genreBySection.entries()) {
      if (keys && !keys.has(sectionKey)) continue;
      for (const g of entries) {
        if (this._isBlockedGenreName(g.title)) continue;
        for (const m of g.items) {
          if (m.ratingKey && !seen.has(m.ratingKey) && this._passesKidsMode(m)) seen.set(m.ratingKey, m);
        }
      }
    }
    let pool = Array.from(seen.values());
    if (excludeKey && pool.length > 1) pool = pool.filter((m) => m.ratingKey !== excludeKey);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _advanceHero() {
    if (this._heroAdvancing || this._currentView === "search") return;
    this._heroAdvancing = true;
    try {
      const next = this._pickHeroItem(this._heroItem?.ratingKey, this._sectionsForView(this._currentView));
      if (!next) return;
      this._heroEl.classList.add("hero-transitioning");
      await this._wait(500);
      this._heroItem = next;
      this._heroVideo = await this._resolveHeroVideo(next);
      this._showHero(true, true);
    } finally {
      /* Always clear this, even if the view changed mid-transition - otherwise a stale
         "opacity: 0" class sticks around and the next _showHero() (e.g. tabbing back to
         Home) renders invisibly. Real wall-clock time already elapsed via the awaits
         above, so the browser has already painted the faded-out frame - removing the
         class here still animates a proper fade-in, no rAF needed. */
      this._heroEl.classList.remove("hero-transitioning");
      this._heroAdvancing = false;
    }
  }

  async _resolveHeroVideo(item) {
    if (this._heroTrailerResolveCount >= this._heroTrailerResolveCap) return null;
    this._heroTrailerResolveCount++;
    try {
      const data = await this._plexFetch(`/library/metadata/${item.ratingKey}/extras`);
      const extras = data?.MediaContainer?.Metadata || [];
      const trailer = extras.find((e) => e.subtype === "trailer");
      const part = trailer?.Media?.[0]?.Part?.[0];
      if (part?.key) {
        return { type: "plex", url: `${this._config.plex_url}${part.key}?X-Plex-Token=${this._config.plex_token}` };
      }
    } catch (e) {
      // fall through to the youtube fallback below
    }
    if (!this._config.youtube_api_key) return null;
    const title = item.title || item.grandparentTitle || "";
    const query = `${title} ${item.year || ""} trailer`.trim();
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", "1");
      url.searchParams.set("q", query);
      url.searchParams.set("key", this._config.youtube_api_key);
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

  _plexImageUrl(path) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${this._config.plex_url}${path}${sep}X-Plex-Token=${this._config.plex_token}`;
  }

  _heroArtUrl(item) {
    return this._plexImageUrl(item.art || item.grandparentArt || "");
  }

  _heroSubtitleText(item) {
    const parts = [];
    if (item.year) parts.push(item.year);
    if (item.contentRating) parts.push(item.contentRating);
    if (item.Genre && item.Genre.length) parts.push(item.Genre.slice(0, 3).map((g) => g.tag).join(", "));
    const runtime = this._formatDuration(item.duration);
    if (runtime) parts.push(runtime);
    return parts.join("   •   ");
  }

  _formatDuration(ms) {
    if (!ms) return "";
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  _heroShouldPlay() {
    return (
      !this._heroUserPaused &&
      this._heroInView &&
      this._heroPageVisible &&
      this._heroWindowFocused
    );
  }

  _updateHeroPlayback() {
    const playing = this._heroShouldPlay();
    this._heroPlayBtn.textContent = playing ? "⏸" : "▶";
    const activeMedia = this._heroMediaLayers[this._heroActiveLayer];
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

  _showHero(preserveMute = false, crossfade = false) {
    clearTimeout(this._heroStaticTimer);
    if (!this._heroItem || this._currentView === "search") {
      this._heroEl.style.display = "none";
      this._rowsEl.classList.remove("overlap-hero");
      return;
    }
    this._heroEl.style.display = "block";
    this._rowsEl.classList.add("overlap-hero");
    this._heroTitleEl.textContent = this._heroItem.title || this._heroItem.grandparentTitle || "";
    this._heroSubtitleEl.textContent = this._heroSubtitleText(this._heroItem);
    this._heroSummaryEl.textContent = (this._heroItem.summary || "").slice(0, 240);

    const heroCanWatchlist = this._heroItem.type === "movie" || this._heroItem.type === "show";
    this._heroWatchlistBtn.style.display = heroCanWatchlist ? "" : "none";
    if (heroCanWatchlist) {
      this._heroWatchlistBtn.classList.remove("busy", "error");
      if (this._isInWatchlist(this._heroItem)) {
        this._heroWatchlistBtn.classList.add("added");
        this._heroWatchlistBtn.textContent = "✓";
        this._heroWatchlistBtn.setAttribute("aria-label", "Remove from My List");
      } else {
        this._heroWatchlistBtn.classList.remove("added");
        this._heroWatchlistBtn.textContent = "+";
        this._heroWatchlistBtn.setAttribute("aria-label", "Add to My List");
      }
    }

    /* preserveMute: an auto-advance (trailer ended -> next random pick) keeps
       whatever sound preference the user already set, instead of resetting on
       every advance - only a fresh Home-tab load/switch should reset to the
       default (unmuted). */
    if (!preserveMute) {
      this._heroMuted = false;
      this._heroMuteBtn.textContent = "🔊";
    }

    const incoming = this._heroMediaLayers[1 - this._heroActiveLayer];
    const outgoing = this._heroMediaLayers[this._heroActiveLayer];
    incoming.style.backgroundImage = `url('${this._heroArtUrl(this._heroItem)}')`;
    incoming.innerHTML = "";
    this._heroMuteBtn.style.display = this._heroVideo ? "" : "none";
    this._heroPlayBtn.style.display = this._heroVideo ? "" : "none";
    if (this._heroVideo?.type === "plex") {
      incoming.innerHTML = `<video src="${this._heroVideo.url}" autoplay muted playsinline></video>`;
      const heroVideoEl = incoming.querySelector("video");
      heroVideoEl.muted = this._heroMuted;
      heroVideoEl.addEventListener("ended", () => this._advanceHero());
    } else if (this._heroVideo?.type === "youtube") {
      /* referrerpolicy is required here: HA's frontend sets <meta name="referrer"
         content="same-origin">, which strips the referrer on this cross-origin request
         entirely - YouTube's player then silently refuses to stream (reports
         "embedder.identity.missing.referrer" and never issues a single googlevideo.com
         request, confirmed via the network log). Setting it on the iframe itself
         overrides the page-level policy for just this element. */
      incoming.innerHTML = `<div class="hero-yt-wrap"><iframe src="${this._heroVideo.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
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
        if (!this._heroMuted) {
          ytIframe.contentWindow?.postMessage(
            JSON.stringify({ event: "command", func: "unMute", args: [] }),
            "*"
          );
        }
        /* The embed always autoplays regardless of our desired state (see
           _updateHeroPlayback's earlier no-op call above). Don't correct that by firing
           pauseVideo immediately here, though - sending a pause as one of the very first
           commands over this raw (non-official-API) postMessage protocol, before the
           player's own autoplay sequence has settled, was observed to leave the embed
           permanently stuck on its unstarted/thumbnail state, never responding to later
           playVideo commands either (reproduced on the HA Companion app's WebView).
           Deferring this re-sync a beat, after the natural autoplay has had a chance to
           actually start, avoids racing it. */
        setTimeout(() => this._updateHeroPlayback(), 400);
        for (let i = 0; i < 8; i++) {
          setTimeout(() => {
            ytIframe.contentWindow?.postMessage(
              JSON.stringify({ event: "command", func: "setPlaybackQuality", args: ["highres"] }),
              "*"
            );
          }, i * 250);
        }
      });
    } else {
      /* No trailer at all (no youtube_api_key, no Plex extra, quota exhausted, etc.) -
         still advance off the static backdrop after a fixed dwell so Home doesn't just
         sit on one item forever when video resolution fails. */
      this._heroStaticTimer = setTimeout(() => this._advanceHero(), 10000);
    }

    /* Restart the pan animation fresh for each new item rather than continuing mid-cycle -
       hero-media-a/b are long-lived elements reused across every hero advance, not fresh
       per item, so the class needs an explicit remove+reflow+re-add (same trick as the
       crossfade-notransition toggle below). */
    incoming.classList.remove("hero-pan");
    if (!this._heroVideo) {
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
    this._heroActiveLayer = 1 - this._heroActiveLayer;
    /* Must run after the flip above - _updateHeroPlayback reads this._heroActiveLayer to
       find the newly-incoming media element, not the outgoing one being torn down. */
    this._updateHeroPlayback();

    clearTimeout(this._heroCrossfadeCleanupTimer);
    this._heroCrossfadeCleanupTimer = setTimeout(() => {
      outgoing.innerHTML = "";
      outgoing.style.backgroundImage = "";
    }, 650);
  }

  _renderCurrentView() {
    const view = this._currentView || "home";
    this._showHero();
    const sectionsForGenres = this._sectionsForView(view);

    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const onDeckFilter = sectionFilters ? (m) => m.type === sectionFilters.onDeck : () => true;
    const otherFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;
    const watchlistFilter = otherFilter;
    const recentlyAddedFilter = otherFilter;
    const recommendedFilter = otherFilter;
    const popularFilter = otherFilter;

    const onDeck = (this._onDeckRaw || [])
      .filter(onDeckFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, true));
    const watchlist = (this._watchlistRaw || [])
      .filter(watchlistFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, false));
    const recentlyAdded = (this._recentlyAddedRaw || [])
      .filter(recentlyAddedFilter)
      .filter((m) => this._passesKidsMode(m))
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, this._config.row_size)
      .map((m) => this._mapItem(m, false));
    const recommended = this._getRecommendedForView(view, recommendedFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, false));
    const popular = (this._popularRaw || [])
      .filter(popularFilter)
      .filter((m) => this._passesKidsMode(m))
      .slice(0, this._config.row_size)
      .map((m) => this._mapItem(m, false));
    const genreRows = this._getGenreRowsForView(view, sectionsForGenres);
    const collectionsRow = this._getCollectionsRowForView(sectionsForGenres);
    const playlistsRow = this._getPlaylistsRowForView(view);

    const rows = [];
    if (onDeck.length) rows.push({ title: "Continue Watching", items: onDeck, source: "local", landscape: true });
    if (recentlyAdded.length) rows.push({ title: "Recently Added", items: recentlyAdded, source: "local" });
    if (watchlist.length) rows.push({ title: "My List", items: watchlist, source: "watchlist" });
    if (recommended.length)
      rows.push({ title: "Recommended for You", items: recommended, source: "local", landscape: true });
    if (popular.length) rows.push({ title: "What's Popular", items: popular, source: "local", rankNumbers: true });
    rows.push(...genreRows);
    if (collectionsRow) rows.push(collectionsRow);
    if (playlistsRow) rows.push(playlistsRow);
    this._renderRows(rows);
  }

  /* Rebuilds just the "My List" row after an add/remove, instead of the full
     _renderCurrentView() - that also unconditionally calls _showHero(), which resets mute
     state and restarts the active hero video/trailer, an unwanted side effect of clicking
     an unrelated poster's watchlist button elsewhere on the page. */
  _refreshWatchlistRow() {
    const view = this._currentView || "home";
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const watchlistFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;
    const watchlist = (this._watchlistRaw || [])
      .filter(watchlistFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, false));

    const existing = this._rowsEl.querySelector('[data-row-key="watchlist"]');
    if (!watchlist.length) {
      if (existing) existing.remove();
      return;
    }

    const sections = Array.from(this._rowsEl.children);
    const rowIndex = existing ? sections.indexOf(existing) : sections.length;
    const nth = this._config.landscape_every_nth;
    const landscape = !!nth && (rowIndex + 1) % nth === 0;
    const newSection = this._buildRowSection({ title: "My List", items: watchlist, source: "watchlist" }, landscape, rowIndex);

    if (existing) {
      existing.replaceWith(newSection);
      return;
    }
    const anchor = sections.find(
      (s) => !["Continue Watching", "Recently Added"].includes(s.querySelector(".row-title")?.textContent)
    );
    if (anchor) this._rowsEl.insertBefore(newSection, anchor);
    else this._rowsEl.appendChild(newSection);
  }

  _getCollectionsRowForView(sections) {
    if (this._kidsMode) return null;
    const keys = new Set(sections.map((s) => s.key));
    const collections = (this._collectionsRaw || []).filter((c) => keys.has(c.section.key));
    if (!collections.length) return null;
    const items = collections.map((c) => ({
      ratingKey: c.ratingKey,
      type: "collection",
      title: c.title,
      subtitle: c.childCount ? `${c.childCount} titles` : "",
      image: this._plexImageUrl(c.thumb),
      art: this._plexImageUrl(c.thumb),
    }));
    return { title: "Collections", items, source: "local" };
  }

  _getPlaylistsRowForView(view) {
    if (this._kidsMode) return null;
    /* Playlists aren't scoped to a single library section like collections are (a
       playlist can mix movies/shows), so there's no clean per-view filter - only show
       this row on the unfiltered Home view rather than guess which playlists "belong"
       to Movies vs. TV. */
    if (view !== "home") return null;
    const playlists = this._playlistsRaw || [];
    if (!playlists.length) return null;
    const items = playlists.map((p) => ({
      ratingKey: p.ratingKey,
      type: "playlist",
      title: p.title,
      subtitle: p.leafCount ? `${p.leafCount} items` : "",
      image: this._plexImageUrl(p.composite),
      art: this._plexImageUrl(p.composite),
    }));
    return { title: "Playlists", items, source: "local" };
  }

  async _fetchOnDeckRaw() {
    try {
      const data = await this._plexFetch("/library/onDeck");
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  async _fetchWatchlistRaw() {
    try {
      const url = new URL("https://discover.provider.plex.tv/library/sections/watchlist/all");
      /* discover.provider.plex.tv is plex.tv's account-level Discover service, not the
         local server - it needs the account token (plex_account_token), not the
         server-specific plex_token, so this scopes correctly per switched Home profile
         instead of always reflecting whichever profile originally signed in. */
      url.searchParams.set("X-Plex-Token", this._config.plex_account_token);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return [];
      const data = await res.json();
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  /* Plex Home profiles - only worth surfacing the switcher UI at all when there's more
     than one (a solo account has nothing to switch to). Failures (no account token yet,
     no Plex Home set up, network error) all collapse to "no switcher", same as an empty
     list - none of them should ever block the rest of the dashboard from loading. */
  async _fetchHomeProfiles() {
    const accountToken = this._config.plex_account_token;
    if (!accountToken) return { users: [], activeId: null };
    try {
      const [users, current] = await Promise.all([
        window.StreamingPlexAuth.getHomeUsers(accountToken),
        window.StreamingPlexAuth.getCurrentUser(accountToken),
      ]);
      const active = users.find((u) => u.uuid && u.uuid === current.uuid) || users.find((u) => u.id === current.id);
      return { users, activeId: active ? active.id : null };
    } catch (e) {
      return { users: [], activeId: null };
    }
  }

  _renderProfileNav() {
    const users = this._homeUsers || [];
    const showSwitcher = users.length > 1;
    this._profileNavItem.hidden = !showSwitcher;
    if (!showSwitcher) return;
    const active = users.find((u) => u.id === this._activeUserId);
    this._profileNavLabel.textContent = active ? active.title : "Profile";
    this._profileNavIcon.innerHTML = active?.thumb
      ? `<span class="nav-profile-avatar"><img src="${this._escape(active.thumb)}" alt="" /></span>`
      : PROFILE_ICON_SVG;
  }

  _openProfileOverlay() {
    this._renderProfileList();
    this._profileOverlay.classList.add("open");
    this._profileNav.focusFirst();
  }

  _closeProfileOverlay() {
    this._profileOverlay.classList.remove("open");
  }

  /* Mobile-only overflow menu (see .nav-more/.nav-item-overflow) - every row here just
     delegates to the real nav item's own click handler instead of reimplementing Profile/
     Kids Mode/Settings/library-switch behavior a second time. */
  _renderMoreSheet() {
    const rows = [];
    this.shadowRoot.querySelectorAll(".nav-item-overflow").forEach((el) => {
      rows.push({
        label: el.querySelector(".nav-label").textContent,
        iconHTML: el.querySelector(".nav-icon").innerHTML,
        active: el.classList.contains("active"),
        target: el,
      });
    });
    if (!this._profileNavItem.hidden) {
      rows.push({
        label: this._profileNavLabel.textContent,
        iconHTML: this._profileNavIcon.innerHTML,
        active: false,
        target: this._profileNavItem,
      });
    }
    rows.push({
      label: "Kids Mode",
      iconHTML: this._kidsToggleBtn.querySelector(".nav-icon").innerHTML,
      active: this._kidsMode,
      target: this._kidsToggleBtn,
    });
    rows.push({
      label: "Settings",
      iconHTML: this._settingsBtn.querySelector(".nav-icon").innerHTML,
      active: false,
      target: this._settingsBtn,
    });
    this._moreListEl.innerHTML = rows
      .map(
        (r) => `
          <button type="button" class="more-sheet-item${r.active ? " active" : ""}" tabindex="0">
            <span class="more-sheet-item-icon">${r.iconHTML}</span>
            <span>${this._escape(r.label)}</span>
          </button>`
      )
      .join("");
    this._moreListEl.querySelectorAll(".more-sheet-item").forEach((btn, i) => {
      btn.addEventListener("click", () => {
        this._closeMoreSheet();
        rows[i].target.click();
      });
    });
  }

  _openMoreSheet() {
    this._renderMoreSheet();
    this._moreOverlay.classList.add("open");
    this._moreNav.focusFirst();
  }

  _closeMoreSheet() {
    this._moreOverlay.classList.remove("open");
  }

  _renderProfileList() {
    const users = this._homeUsers || [];
    this._profileListEl.innerHTML = users
      .map((u) => {
        const isActive = u.id === this._activeUserId;
        const avatar = u.thumb ? `<img src="${this._escape(u.thumb)}" alt="" />` : PROFILE_ICON_SVG;
        return `
        <div class="profile-row${isActive ? " active" : ""}" data-id="${u.id}">
          <div class="profile-avatar">${avatar}</div>
          <div class="profile-name">${this._escape(u.title)}</div>
          <button type="button" class="profile-switch-btn" ${isActive ? "disabled" : ""}>${isActive ? "Current" : "Switch"}</button>
          <div class="profile-row-status"></div>
        </div>`;
      })
      .join("");
    this._profileListEl.querySelectorAll(".profile-row").forEach((rowEl) => {
      if (rowEl.classList.contains("active")) return;
      const user = users.find((u) => u.id === Number(rowEl.dataset.id));
      rowEl.querySelector(".profile-switch-btn").addEventListener("click", () => this._switchToUser(user, rowEl));
    });
  }

  /* Redirects an episode click to the parent show's info modal, landing on the season/
     episode it came from (via _pendingEpisodeFocus, consumed in _loadTitleInfoSeasons)
     instead of opening a dedicated single-episode modal. item.image/art already resolve
     to the show's own thumb/art here (see _mapItem's grandparentThumb/grandparentArt
     fallback for episodes), so the optimistic paint before the real fetch is accurate.
     _titleInfoResumeEpisodeKey remembers which episode this show modal stands in for, so
     the Play button resumes that episode instead of trying to "play" the show container
     itself, which isn't a playable item (StreamingPlayer.play fails on it and falls back
     to _tapUrl's web/details link - the "thrown to the Plex website" regression this
     comment is here to prevent reintroducing). */
  async _openTitleInfoForEpisode(item, source) {
    this._pendingEpisodeFocus = { seasonRatingKey: item.seasonKey, episodeRatingKey: item.ratingKey };
    const showItem = {
      ratingKey: item.showKey,
      type: "show",
      title: item.title,
      subtitle: "",
      image: item.image,
      art: item.art,
    };
    await this._openTitleInfo(showItem, source);
    if (this._titleInfoItem === showItem) this._titleInfoResumeEpisodeKey = item.ratingKey;
  }

  /* Opens instantly from whatever's already known about the item (title/image, via the
     existing _mapItem shape) so there's no blank-modal flash, then fills in the rest
     from a full /library/metadata fetch. A watchlist item's own ratingKey is scoped to
     discover.provider.plex.tv, not this server, so it's resolved to a local ratingKey
     first via _resolveLocalRatingKey. A watchlist item that isn't in this server's
     library at all is a legitimate case, not an error - it just skips the detail fetch
     and leaves Play falling back to the Discover deep link in _tapUrl. An episode (e.g.
     from Continue Watching) redirects to its show's info instead of a standalone episode
     modal - see _openTitleInfoForEpisode. */
  async _openTitleInfo(item, source) {
    if (item.type === "episode" && item.showKey) {
      return this._openTitleInfoForEpisode(item, source);
    }
    this._titleInfoResumeEpisodeKey = null;
    this._titleInfoItem = item;
    this._titleInfoSource = source;
    this._titleInfoDuration = null;
    this._titleInfoViewOffset = 0;
    this._titleInfoMarkers = [];
    this._titleInfoChapters = [];
    this._titleInfoMedia = [];
    this._titleInfoSelectedMediaIndex = 0;
    this._titleInfoQualityCapKbps = null;
    this._titleInfoQualityBtn.hidden = true;
    this._titleInfoProgress.hidden = !(item.progress > 0);
    this._titleInfoProgressBar.style.width = `${Math.round((item.progress || 0) * 100)}%`;
    const art = item.art || item.image || "";
    this._titleInfoArt.style.backgroundImage = art ? `url('${art}')` : "none";
    this._titleInfoModal.style.setProperty("--title-info-bg", art ? `url('${art}')` : "none");
    this._titleInfoTitleEl.textContent = item.title || "";
    this._titleInfoMetaEl.innerHTML = item.subtitle ? `<span>${this._escape(item.subtitle)}</span>` : "";
    this._titleInfoSummaryEl.textContent = "";
    this._titleInfoEpisodesEl.innerHTML = "";
    this._titleInfoCastWrap.hidden = true;
    this._titleInfoCastEl.innerHTML = "";
    this._titleInfoSimilarWrap.hidden = true;
    this._titleInfoSimilarEl.innerHTML = "";
    const canWatchlist = item.type === "movie" || item.type === "show";
    this._titleInfoWatchlistBtn.hidden = !canWatchlist;
    if (canWatchlist) {
      const added = this._isInWatchlist(item);
      this._titleInfoWatchlistBtn.classList.toggle("added", added);
      this._titleInfoWatchlistBtn.textContent = added ? "✓" : "+";
      this._titleInfoWatchlistBtn.setAttribute("aria-label", added ? "Remove from My List" : "Add to My List");
    }
    this._titleInfoOverlay.classList.add("open");
    this._titleInfoOverlay.focus();

    let ratingKey = item.ratingKey;
    if (source === "watchlist") {
      ratingKey = await this._resolveLocalRatingKey(item);
      if (this._titleInfoItem !== item) return;
      /* Swap the item's Discover-scoped ratingKey for the resolved local one so
         downstream staleness checks (_loadTitleInfoSimilar/_loadTitleInfoSeasons
         compare against this._titleInfoItem.ratingKey) and Play's native playback
         request both key off the ID that actually exists on this server. */
      item.ratingKey = ratingKey;
    }
    if (!ratingKey) return;
    try {
      const data = await this._plexFetch(`/library/metadata/${ratingKey}`);
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (meta && this._titleInfoItem === item) this._renderTitleInfoDetail(meta);
    } catch (e) {
      // detail is best-effort - the poster/title painted above stays usable on failure
    }
  }

  _closeTitleInfo() {
    this._titleInfoOverlay.classList.remove("open");
    this._titleInfoItem = null;
  }

  /* The home screen (sidenav + hero + a 2D grid of poster rows) isn't a single list -
     wireLinearNav's 1D model doesn't cover "Left/Right moves within whichever row
     currently has focus, Up/Down moves between rows while roughly preserving column
     position." Scoped by checking active-element membership first, so it never fires
     while a modal overlay (which registers its own handler elsewhere) currently owns
     focus - only one handler ever actually acts on a given keypress since focus is a
     singleton. */
  _wireHomeNav() {
    const sidenavItems = () =>
      Array.from(this.shadowRoot.querySelectorAll(".nav-item")).filter((el) => el.offsetParent !== null);
    const heroItems = () =>
      Array.from(this.shadowRoot.querySelectorAll(".hero-info-btn, .hero-watchlist-btn, .hero-play-btn, .hero-mute-btn")).filter(
        (el) => el.offsetParent !== null
      );
    const rowSections = () =>
      Array.from(this.shadowRoot.querySelectorAll(".row-section")).filter((s) => s.offsetParent !== null);
    const postersIn = (section) =>
      section ? Array.from(section.querySelectorAll(".poster")).filter((el) => el.offsetParent !== null) : [];

    registerNavHandler((command, e, active) => {
      const inSidenav = sidenavItems().includes(active);
      const inHero = !inSidenav && heroItems().includes(active);
      const posterSection = !inSidenav && !inHero && active?.classList?.contains("poster") ? active.closest(".row-section") : null;

      if (!inSidenav && !inHero && !posterSection) {
        /* Every registered handler sees every keydown regardless of which one owns
           focus - a handler returning false here must NOT assume that means "nothing is
           focused," only "not focused in my scope" (a modal overlay's own handler may
           legitimately own this keypress instead). Only the true fresh-load case (no
           active element anywhere, or it's just document.body/the card host with
           nothing focused inside) gets the lazy first-D-pad-press starting point;
           anything else falls through untouched, letting the real owner act instead of
           this handler stealing focus mid-interaction with some other overlay. */
        const nothingFocusedYet = !active || active === document.body || active === this;
        if (nothingFocusedYet && ["up", "down", "left", "right"].includes(command)) {
          sidenavItems()[0]?.focus();
          return true;
        }
        return false;
      }

      if (command === "activate") {
        active.click();
        return true;
      }

      if (inSidenav) {
        const list = sidenavItems();
        const idx = list.indexOf(active);
        if (command === "down") {
          list[Math.min(idx + 1, list.length - 1)].focus();
          return true;
        }
        if (command === "up") {
          list[Math.max(idx - 1, 0)].focus();
          return true;
        }
        if (command === "right") {
          const target = heroItems()[0] || postersIn(rowSections()[0])[0];
          target?.focus();
          return true;
        }
        return false;
      }

      if (inHero) {
        const list = heroItems();
        const idx = list.indexOf(active);
        if (command === "right") {
          list[Math.min(idx + 1, list.length - 1)].focus();
          return true;
        }
        if (command === "left") {
          if (idx <= 0) sidenavItems()[0]?.focus();
          else list[idx - 1].focus();
          return true;
        }
        if (command === "down") {
          postersIn(rowSections()[0])[0]?.focus();
          return true;
        }
        if (command === "up") return true; // nothing above the hero - swallow, don't fall through
        return false;
      }

      // posterSection
      const posters = postersIn(posterSection);
      const idx = posters.indexOf(active);
      if (command === "right") {
        posters[Math.min(idx + 1, posters.length - 1)].focus();
        return true;
      }
      if (command === "left") {
        if (idx <= 0) sidenavItems()[0]?.focus();
        else posters[idx - 1].focus();
        return true;
      }
      if (command === "down" || command === "up") {
        const sections = rowSections();
        const sectionIdx = sections.indexOf(posterSection);
        if (command === "up" && sectionIdx === 0) {
          heroItems()[0]?.focus();
          return true;
        }
        const targetSection = sections[sectionIdx + (command === "down" ? 1 : -1)];
        if (!targetSection) return true; // no more rows that way - swallow
        const targetPosters = postersIn(targetSection);
        const target = targetPosters[Math.min(idx, targetPosters.length - 1)];
        target?.focus();
        target?.scrollIntoView({ block: "nearest", inline: "center" });
        return true;
      }
      return false;
    });
  }

  _openQualityPicker() {
    this._renderQualityPicker();
    this._qualityPickerOverlay.classList.add("open");
    this._qualityPickerDoneBtn.focus();
  }

  _closeQualityPicker() {
    this._qualityPickerOverlay.classList.remove("open");
  }

  /* Version rows describe whatever Plex's Media[] actually reports (resolution/codec/
     bitrate field names unverified against a real multi-version item - see this
     phase's open risks); Quality Cap rows are the fixed QUALITY_CAP_PRESETS list.
     Re-rendered on every selection so the "selected" highlight stays in sync without a
     separate diffing step. */
  _renderQualityPicker() {
    const media = this._titleInfoMedia || [];
    this._qualityPickerVersionsEl.innerHTML = media.length
      ? media
          .map((m, i) => {
            const parts = [];
            if (m.videoResolution) parts.push(String(m.videoResolution));
            if (m.videoCodec) parts.push(m.videoCodec.toUpperCase());
            if (m.bitrate) parts.push(`${(m.bitrate / 1000).toFixed(1)} Mbps`);
            const label = parts.join(" · ") || `Version ${i + 1}`;
            const selected = (this._titleInfoSelectedMediaIndex || 0) === i;
            return `<button type="button" class="quality-picker-option${selected ? " selected" : ""}" data-media-index="${i}">${this._escape(label)}</button>`;
          })
          .join("")
      : `<div class="title-info-loading">Only one version available</div>`;
    this._qualityPickerVersionsEl.querySelectorAll(".quality-picker-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._titleInfoSelectedMediaIndex = Number(btn.dataset.mediaIndex);
        this._renderQualityPicker();
      });
    });

    this._qualityPickerCapsEl.innerHTML = QUALITY_CAP_PRESETS.map((preset) => {
      const selected = (this._titleInfoQualityCapKbps ?? null) === preset.kbps;
      return `<button type="button" class="quality-picker-option${selected ? " selected" : ""}" data-kbps="${preset.kbps ?? ""}">${this._escape(preset.label)}</button>`;
    }).join("");
    this._qualityPickerCapsEl.querySelectorAll(".quality-picker-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._titleInfoQualityCapKbps = btn.dataset.kbps ? Number(btn.dataset.kbps) : null;
        this._renderQualityPicker();
      });
    });
  }

  _renderTitleInfoDetail(meta) {
    this._titleInfoDuration = meta.duration || null;
    this._titleInfoViewOffset = meta.viewOffset || 0;
    this._titleInfoMarkers = meta.Marker || [];
    this._titleInfoChapters = meta.Chapter || [];
    this._titleInfoMedia = meta.Media || [];
    this._titleInfoQualityBtn.hidden = !this._titleInfoMedia.length;
    const progress = meta.duration ? Math.max(0, Math.min(1, this._titleInfoViewOffset / meta.duration)) : 0;
    this._titleInfoProgress.hidden = progress <= 0;
    this._titleInfoProgressBar.style.width = `${Math.round(progress * 100)}%`;
    this._titleInfoSummaryEl.textContent = meta.summary || "";

    const metaParts = [];
    if (meta.contentRating) metaParts.push(meta.contentRating);
    if (meta.year) metaParts.push(String(meta.year));
    if (meta.duration) metaParts.push(this._formatRuntime(meta.duration));
    const rating = meta.audienceRating || meta.rating;
    if (rating) metaParts.push(`★ ${Number(rating).toFixed(1)}`);
    if (meta.Genre?.length) metaParts.push(meta.Genre.slice(0, 3).map((g) => g.tag).join(", "));
    this._titleInfoMetaEl.innerHTML = metaParts.map((p) => `<span>${this._escape(p)}</span>`).join("");

    const cast = (meta.Role || []).slice(0, 12);
    this._titleInfoCastWrap.hidden = !cast.length;
    this._titleInfoCastEl.innerHTML = cast
      .map((r) => {
        const fallback = `<div class="title-info-cast-avatar-fallback">${PROFILE_ICON_SVG}</div>`;
        const avatar = r.thumb
          ? `<img src="${this._escape(this._plexImageUrl(r.thumb))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
             <div class="title-info-cast-avatar-fallback" style="display:none">${PROFILE_ICON_SVG}</div>`
          : fallback;
        const role = r.role ? `<div class="title-info-cast-role">${this._escape(r.role)}</div>` : "";
        return `<div class="title-info-cast-chip"><div class="title-info-cast-avatar">${avatar}</div><div class="title-info-cast-name">${this._escape(r.tag)}</div>${role}</div>`;
      })
      .join("");

    if (meta.type === "show") this._loadTitleInfoSeasons(meta.ratingKey);
    this._loadTitleInfoSimilar(meta.ratingKey);
  }

  _formatRuntime(ms) {
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  async _loadTitleInfoSeasons(showRatingKey) {
    try {
      const data = await this._plexFetch(`/library/metadata/${showRatingKey}/children`);
      const seasons = (data?.MediaContainer?.Metadata || []).filter((s) => s.index != null);
      if (!seasons.length || this._titleInfoItem?.ratingKey !== showRatingKey) return;

      this._titleInfoEpisodesEl.innerHTML = "";
      const select = document.createElement("select");
      select.className = "title-info-season-select";
      select.innerHTML = seasons
        .map((s) => `<option value="${s.ratingKey}">${this._escape(s.title || `Season ${s.index}`)}</option>`)
        .join("");
      const list = document.createElement("div");
      this._titleInfoEpisodesEl.appendChild(select);
      this._titleInfoEpisodesEl.appendChild(list);

      const showSeason = async (seasonRatingKey, focusEpisodeRatingKey) => {
        list.innerHTML = '<div class="title-info-loading">Loading episodes…</div>';
        const epData = await this._plexFetch(`/library/metadata/${seasonRatingKey}/children`);
        if (this._titleInfoItem?.ratingKey !== showRatingKey) return;
        const episodes = epData?.MediaContainer?.Metadata || [];
        list.innerHTML = episodes
          .map((ep) => {
            const progress = ep.duration ? Math.max(0, Math.min(1, (ep.viewOffset || 0) / ep.duration)) : 0;
            const watched = !!ep.viewCount && progress <= 0;
            return `
          <div class="title-info-episode" data-rating-key="${ep.ratingKey}">
            <div class="title-info-episode-thumb">
              <img loading="lazy" src="${this._escape(this._plexImageUrl(ep.thumb))}" alt="" />
              ${watched ? `<div class="title-info-episode-watched">${WATCHED_ICON_SVG}</div>` : ""}
              ${
                progress > 0
                  ? `<div class="title-info-episode-progress"><div class="bar" style="width:${Math.round(progress * 100)}%"></div></div>`
                  : ""
              }
              <div class="title-info-episode-play"><div class="title-info-episode-play-icon">▶</div></div>
            </div>
            <div>
              <div class="title-info-episode-title">${ep.index}. ${this._escape(ep.title)}</div>
              <div class="title-info-episode-summary">${this._escape(ep.summary || "")}</div>
            </div>
          </div>`;
          })
          .join("");
        list.querySelectorAll(".title-info-episode").forEach((row) => {
          row.addEventListener("click", () => {
            const ep = episodes.find((e) => String(e.ratingKey) === row.dataset.ratingKey);
            if (!ep) return;
            this._playItem(this._mapItem(ep, true), {
              durationMs: ep.duration || null,
              startOffsetMs: ep.viewOffset || 0,
              source: "local",
              markers: ep.Marker || [],
              chapters: ep.Chapter || [],
            });
          });
        });
        if (focusEpisodeRatingKey) {
          const row = list.querySelector(`[data-rating-key="${focusEpisodeRatingKey}"]`);
          if (row) {
            row.classList.add("current");
            row.scrollIntoView({ block: "center" });
          }
        }
      };
      select.addEventListener("change", () => showSeason(select.value));
      /* Opening a show from an episode (e.g. Continue Watching) requests landing on that
         episode's own season/row instead of always season 1 - see _openTitleInfoForEpisode. */
      const focus = this._pendingEpisodeFocus;
      this._pendingEpisodeFocus = null;
      const focusSeason = focus && seasons.find((s) => String(s.ratingKey) === String(focus.seasonRatingKey));
      const initialSeasonKey = focusSeason ? focusSeason.ratingKey : seasons[0].ratingKey;
      select.value = initialSeasonKey;
      showSeason(initialSeasonKey, focusSeason ? focus.episodeRatingKey : null);
    } catch (e) {
      // episode list is supplementary; leave the rest of the modal usable on failure
    }
  }

  async _loadTitleInfoSimilar(ratingKey) {
    try {
      const data = await this._plexFetch(`/library/metadata/${ratingKey}/related`);
      const items = (data?.MediaContainer?.Hub || []).flatMap((h) => h.Metadata || []).slice(0, 12);
      if (!items.length || this._titleInfoItem?.ratingKey !== ratingKey) return;
      this._titleInfoSimilarWrap.hidden = false;
      this._titleInfoSimilarEl.innerHTML = items
        .map((m) => {
          const mapped = this._mapItem(m, false);
          return `
          <div class="title-info-similar-item" data-rating-key="${mapped.ratingKey}">
            <img loading="lazy" src="${this._escape(mapped.image)}" alt="" />
            <div class="t">${this._escape(mapped.title)}</div>
          </div>`;
        })
        .join("");
      this._titleInfoSimilarEl.querySelectorAll(".title-info-similar-item").forEach((el, i) => {
        el.addEventListener("click", () => this._openTitleInfo(this._mapItem(items[i], false), "local"));
      });
    } catch (e) {
      // similar titles are supplementary; leave the rest of the modal usable on failure
    }
  }

  async _playTitleInfoItem() {
    if (this._titleInfoResumeEpisodeKey) {
      return this._playEpisodeByRatingKey(this._titleInfoResumeEpisodeKey);
    }
    const item = this._titleInfoItem;
    if (!item) return;
    await this._playItem(item, {
      durationMs: this._titleInfoDuration,
      startOffsetMs: this._titleInfoViewOffset,
      source: this._titleInfoSource,
      markers: this._titleInfoMarkers,
      chapters: this._titleInfoChapters,
      mediaIndex: this._titleInfoSelectedMediaIndex || 0,
      qualityCapKbps: this._titleInfoQualityCapKbps,
    });
  }

  /* Fetches the episode's own fresh duration/viewOffset (the show-level modal's
     _titleInfoDuration/_titleInfoViewOffset are always null/0 - shows don't carry those
     fields) so resuming from the show modal's Play button seeks to the right spot. */
  async _playEpisodeByRatingKey(ratingKey) {
    try {
      const data = await this._plexFetch(`/library/metadata/${ratingKey}`);
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (!meta) return;
      await this._playItem(this._mapItem(meta, true), {
        durationMs: meta.duration || null,
        startOffsetMs: meta.viewOffset || 0,
        source: "local",
        markers: meta.Marker || [],
        chapters: meta.Chapter || [],
      });
    } catch (e) {
      // best-effort - Play simply won't respond if this fails
    }
  }

  /* Prefers window.StreamingPlayer (native on Android, <video>+hls.js everywhere else -
     see plex-player.js) and only falls back to handing off via _tapUrl (native Plex app /
     Plex web player) when that's unavailable or playback fails to start - e.g. a
     watchlist item with no local ratingKey, which StreamingPlayer.play rejects by design.
     Shared by the title-info modal's Play button and the episode list's direct-play rows. */
  async _playItem(item, { durationMs = null, startOffsetMs = 0, source, markers = [], chapters = [], mediaIndex = 0, qualityCapKbps = null } = {}) {
    if (window.StreamingPlayer) {
      try {
        await window.StreamingPlayer.play({
          ratingKey: item.ratingKey,
          key: item.key,
          type: item.type,
          plexUrl: this._config.plex_url,
          plexToken: this._config.plex_token,
          durationMs,
          startOffsetMs,
          markers,
          chapters,
          mediaIndex,
          qualityCapKbps,
          /* Already produced by _mapItem for every call site - title is the show's own
             title (not the episode's) for episode items, which is what a subtitle search
             query needs to key off, not the individual episode title. */
          title: item.title,
          year: item.year,
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
        });
        return;
      } catch (e) {
        // fall through to the deep-link fallback below
      }
    }
    window.open(this._tapUrl(item, source), "_blank");
  }

  /* Protected profiles get prompted through the same numeric-keypad modal Kids Mode
     uses to exit (see _promptForDigits/_verifyKidsPin above) instead of a plain text
     input - one PIN-entry UI in the app, not two. Unlike Kids Mode, a wrong entry here
     isn't retried automatically: only Plex can say whether it was right, so a rejected
     PIN just reports the error and leaves the user to press "Switch" again. */
  async _switchToUser(user, rowEl) {
    let pin;
    if (user.protected) {
      pin = await this._promptForDigits(4, `Enter PIN for ${user.title}`);
      if (pin === null) return;
    }
    rowEl.classList.add("busy");
    const statusEl = rowEl.querySelector(".profile-row-status");
    statusEl.textContent = "";
    try {
      const accountToken = this._config.plex_account_token;
      const newAccountToken = await window.StreamingPlexAuth.switchHomeUser(accountToken, user.id, pin);
      const servers = await window.StreamingPlexAuth.discoverServers(newAccountToken);
      const server = servers.find((s) => s.clientIdentifier && s.clientIdentifier === this._config.machine_id) || servers[0];
      if (!server) throw new Error("This profile can't reach the connected Plex server.");
      const existingSecrets = window.StreamingVault.hasSecrets() ? await window.StreamingVault.loadSecrets() : {};
      const secrets = { ...existingSecrets, plex_token: server.accessToken, plex_account_token: newAccountToken };
      await window.StreamingVault.saveSecrets(secrets);
      this._config.plex_token = server.accessToken;
      this._config.plex_account_token = newAccountToken;
      this._activeUserId = user.id;
      this._closeProfileOverlay();
      await this._loadAll();
    } catch (e) {
      rowEl.classList.remove("busy");
      statusEl.textContent = e.message;
    }
  }

  async _fetchWatchHistoryRaw() {
    try {
      const data = await this._plexFetch("/status/sessions/history/all", {
        sort: "viewedAt:desc",
        "X-Plex-Container-Size": 500,
      });
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  async _fetchRecentlyAddedRaw() {
    const rowSize = this._config.row_size;
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
            type: s.type,
            sort: "addedAt:desc",
            "X-Plex-Container-Size": rowSize,
          });
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat();
  }

  async _fetchCollectionsRaw() {
    /* Deliberately NOT the /library/sections/{key}/collection (singular) endpoint used by
       _loadSearchFacets below - that one is Plex's filter-facet listing and only returns
       {key, title}, no ratingKey/thumb/childCount. The real collection objects (with
       posters) live at the plural /collections endpoint, under MediaContainer.Metadata.
       No `type` param here, deliberately - passing the section's type (e.g. 1 for movie)
       makes Plex return every movie in the section instead of the collection objects
       themselves (confirmed empirically), unlike every other endpoint in this file. */
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/collections`);
          return (data?.MediaContainer?.Metadata || []).map((d) => ({ ...d, section: s }));
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat();
  }

  /* Fetches actual movie items for a handful of randomly-picked real Plex Collections
     (picked fresh in _loadAll each real page load) so they can be mixed in as their own
     titled rows - title = collection name, items = its movies - alongside genre/AI rows.
     Uses the dedicated /library/collections/{ratingKey}/children endpoint, NOT a
     `collection=` filter param against /all - confirmed empirically that the latter does
     NOT filter by the collection at all (it silently matched a single unrelated movie
     instead of the collection's real members). The children endpoint also doesn't respect
     sort/X-Plex-Container-Size query params (tested), but returns items in a sensible
     built-in order (chronological/release order) already, and row-size slicing happens
     client-side in _buildCollectionRows anyway, so no params are needed here. */
  async _fetchCollectionRowItems(picks) {
    const results = await Promise.all(
      picks.map(async (c) => {
        try {
          const data = await this._plexFetch(`/library/collections/${c.ratingKey}/children`);
          return { title: c.title, items: data?.MediaContainer?.Metadata || [] };
        } catch (e) {
          return { title: c.title, items: [] };
        }
      })
    );
    return results.filter((r) => r.items.length);
  }

  async _fetchPlaylistsRaw() {
    /* Server-wide endpoint, not per-section like collections - a playlist can span
       multiple libraries. Posters live under `composite`, not `thumb` (confirmed via
       raw JSON, unlike every other item type in this file). Filtered to playlistType
       "video" since this dashboard has no audio/music sections configured. */
    try {
      const data = await this._plexFetch("/playlists");
      return (data?.MediaContainer?.Metadata || []).filter((p) => p.playlistType === "video");
    } catch (e) {
      return [];
    }
  }

  async _loadSearchFacets() {
    const studios = [];
    const collections = [];
    await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/studio`, { type: s.type });
          for (const d of data?.MediaContainer?.Directory || []) {
            studios.push({ title: d.title, key: d.key, section: s });
          }
        } catch (e) {}
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/collection`, { type: s.type });
          for (const d of data?.MediaContainer?.Directory || []) {
            collections.push({ title: d.title, key: d.key, section: s });
          }
        } catch (e) {}
      })
    );
    return { studios, collections };
  }

  async _loadGenreDataBySection() {
    const sections = this._config.sections;
    const rowSize = this._config.row_size;
    const result = new Map();

    await Promise.all(
      sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/genre`, { type: s.type });
          const genres = data?.MediaContainer?.Directory || [];
          const perGenre = await Promise.all(
            genres.map(async (g) => {
              try {
                const gdata = await this._plexFetch(`/library/sections/${s.key}/all`, {
                  type: s.type,
                  genre: g.key,
                  sort: "addedAt:desc",
                  "X-Plex-Container-Size": rowSize,
                });
                const mc = gdata?.MediaContainer || {};
                return { title: g.title, key: g.key, items: mc.Metadata || [], totalSize: mc.totalSize ?? mc.size ?? 0 };
              } catch (e) {
                return { title: g.title, key: g.key, items: [], totalSize: 0 };
              }
            })
          );
          result.set(s.key, perGenre);
        } catch (e) {
          result.set(s.key, []);
        }
      })
    );

    return result;
  }

  _getRecommendedForView(view, filterFn) {
    if (!this._recommendedRowCache) this._recommendedRowCache = {};
    if (!this._recommendedRowCache[view]) {
      const rowSize = this._config.row_size;
      /* Wider pool (2x row_size) keeps the row anchored to genuinely high-affinity
         matches - unlike genre rows, which shuffle across the whole eligible set. */
      const pool = (this._recommendedRaw || []).filter(filterFn).slice(0, rowSize * 2);
      this._recommendedRowCache[view] = this._shuffle(pool).slice(0, rowSize);
    }
    return this._recommendedRowCache[view];
  }

  _getGenreRowsForView(view, sections) {
    if (!this._genreRowsCache) this._genreRowsCache = {};
    if (!this._genreRowsCache[view]) {
      const genreRows = this._mergeGenreRows(sections);
      const aiRows = this._buildAiRows(view);
      const collectionRows = this._buildCollectionRows(view);
      /* Collection rows are guaranteed to appear (reserved out of the max_genre_rows cap
         below) rather than competing for a slot like genre/AI rows - but still shuffled
         into a random position together with everything else, not pinned to a fixed spot. */
      const pool = this._shuffle([...genreRows, ...aiRows]).slice(
        0,
        Math.max(0, this._config.max_genre_rows - collectionRows.length)
      );
      this._genreRowsCache[view] = this._shuffle([...pool, ...collectionRows]);
    }
    return this._genreRowsCache[view];
  }

  /* Collection rows: title = a real Plex Collection's name, items = its actual movies -
     picked randomly per real page load in _loadAll (see _collectionRowPicks), unlike
     genre/AI rows which are recomputed from the full pool every time. No totalSize>=5
     floor here (unlike _mergeGenreRows) - collections are hand-curated and small ones
     (e.g. a 2-film franchise) are still worth showing as-is. */
  _buildCollectionRows(view) {
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const typeFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;

    const rowSize = this._config.row_size;
    return (this._collectionRowsRaw || [])
      .map((r) => {
        const items = r.items
          .filter(typeFilter)
          .filter((m) => this._passesKidsMode(m))
          .slice(0, rowSize);
        return { title: r.title, source: "collection", items: items.map((m) => this._mapItem(m, false)) };
      })
      .filter((r) => r.items.length > 0);
  }

  _buildAiRows(view) {
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const typeFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;

    const rowSize = this._config.row_size;
    return (this._aiRowsRaw || [])
      .filter((r) => !(r.genres || []).some((g) => this._isBlockedGenreName(g)))
      .map((r) => {
        const items = r.items
          .filter(typeFilter)
          .filter((m) => this._passesKidsMode(m))
          .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
          .slice(0, rowSize);
        return { title: r.label, source: "ai", items: items.map((m) => this._mapItem(m, false)) };
      })
      .filter((r) => r.items.length >= 5);
  }

  /* The model is asked for strict JSON but may still wrap it in a code fence or
     return junk, so this validates everything regardless of source. */
  _parseAiSectionIdeas(raw) {
    const MAX_IDEAS = 15;
    try {
      if (!raw) return [];
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (idea) =>
            idea &&
            typeof idea.label === "string" &&
            idea.label.trim() &&
            Array.isArray(idea.genres) &&
            idea.genres.length >= 1 &&
            idea.genres.length <= 2 &&
            idea.genres.every((g) => typeof g === "string" && g.trim())
        )
        .slice(0, MAX_IDEAS);
    } catch (e) {
      return [];
    }
  }

  /* AI row ideas, fetched directly from OpenRouter with the user's own key (Settings)
     and cached in localStorage - no server/HA dependency. Falls back to the last good
     cache entry on any fetch/parse error rather than dropping the feature for the
     session, and skips the network entirely with no key configured. */
  async _loadAiIdeas() {
    const key = this._config.openrouter_api_key;
    if (!key) return [];
    const cacheKey = "prism.aiIdeasCache";
    const cadenceMs = this._config.ai_rows_cadence_ms;
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    } catch (e) {
      cached = null;
    }
    if (cached && Array.isArray(cached.ideas) && Date.now() - cached.fetchedAt < cadenceMs) {
      return cached.ideas;
    }
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct",
          messages: [
            {
              role: "user",
              content:
                "Generate a JSON array of exactly 10 objects. Each object must have a label field (a short catchy row title, 2 to 5 words) and a genres field (an array of 1 or 2 genre words drawn only from this list: Action, Adventure, Animation, Anime, Biography, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Musical, Mystery, Romance, Sci-Fi, Sport, Suspense, Thriller, War, Western). About half the ideas should combine two different genres for interesting mixes, for example Sci-Fi Comedy would have genres Sci-Fi and Comedy. Respond with ONLY the raw JSON array. No markdown code fences. No explanation. No extra text before or after the array.",
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
      const data = await res.json();
      const ideas = this._parseAiSectionIdeas(data?.choices?.[0]?.message?.content);
      if (ideas.length) localStorage.setItem(cacheKey, JSON.stringify({ ideas, fetchedAt: Date.now() }));
      return ideas;
    } catch (e) {
      return (cached && cached.ideas) || [];
    }
  }

  async _fetchAiRowsRaw(ideas) {
    const rowSize = this._config.row_size;
    const results = await Promise.all(
      ideas.map(async (idea) => {
        const perSection = await Promise.all(
          this._config.sections.map(async (s) => {
            const genreEntries = (this._genreBySection && this._genreBySection.get(s.key)) || [];
            const keys = idea.genres.map((g) => {
              const norm = g.trim().toLowerCase();
              const match = genreEntries.find((e) => e.title.trim().toLowerCase() === norm);
              return match ? match.key : null;
            });
            if (keys.some((k) => !k)) return [];
            try {
              const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
                type: s.type,
                genre: keys,
                sort: "addedAt:desc",
                "X-Plex-Container-Size": rowSize,
              });
              return data?.MediaContainer?.Metadata || [];
            } catch (e) {
              return [];
            }
          })
        );
        return { label: idea.label, genres: idea.genres, items: perSection.flat() };
      })
    );
    return results.filter((r) => r.items.length);
  }

  _mergeGenreRows(sections) {
    const merged = new Map();
    for (const s of sections) {
      const entries = (this._genreBySection && this._genreBySection.get(s.key)) || [];
      for (const g of entries) {
        if (this._isBlockedGenreName(g.title)) continue;
        const norm = g.title.trim().toLowerCase();
        if (!merged.has(norm)) merged.set(norm, { title: g.title, items: [], totalSize: 0 });
        const bucket = merged.get(norm);
        bucket.items.push(...g.items.filter((m) => this._passesKidsMode(m)));
        bucket.totalSize += g.totalSize;
      }
    }

    const rowSize = this._config.row_size;
    const eligible = Array.from(merged.values())
      .map((g) => {
        const items = [...g.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, rowSize);
        return {
          title: g.title,
          source: "local",
          totalSize: g.totalSize,
          items: items.map((m) => this._mapItem(m, false)),
        };
      })
      .filter((r) => r.totalSize >= 5 && r.items.length);

    return this._shuffle(eligible);
  }

  /* Genre-affinity recommender: scores every unwatched library item by how much its
     genres overlap with genres pulled from watch history, weighted so more-recently-
     watched items count for more. Pure local-PMS data (history + genre listings already
     fetched elsewhere) - no Plex cloud/Discover dependency, unlike the watchlist fetch. */
  _buildRecommendedRaw(historyRaw) {
    const pool = new Map();
    for (const entries of this._genreBySection.values()) {
      for (const g of entries) {
        if (this._isBlockedGenreName(g.title)) continue;
        for (const m of g.items) {
          if (m.ratingKey && !pool.has(m.ratingKey)) pool.set(m.ratingKey, m);
        }
      }
    }

    const excluded = new Set((this._onDeckRaw || []).map((m) => m.grandparentRatingKey || m.ratingKey));
    const genreScore = new Map();
    historyRaw.forEach((h, i) => {
      const key = h.grandparentRatingKey || h.ratingKey;
      if (!key) return;
      excluded.add(key);
      const item = pool.get(key);
      if (!item || !Array.isArray(item.Genre)) return;
      const weight = historyRaw.length - i;
      for (const g of item.Genre) {
        const norm = (g.tag || "").trim().toLowerCase();
        if (!norm) continue;
        genreScore.set(norm, (genreScore.get(norm) || 0) + weight);
      }
    });
    if (!genreScore.size) return [];

    const scored = [];
    for (const [key, item] of pool.entries()) {
      if (excluded.has(key) || !Array.isArray(item.Genre)) continue;
      let score = 0;
      for (const g of item.Genre) {
        score += genreScore.get((g.tag || "").trim().toLowerCase()) || 0;
      }
      if (score > 0) scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score || (b.item.addedAt || 0) - (a.item.addedAt || 0));
    return scored.map((s) => s.item);
  }

  /* "What's Popular" row: blended recency + audience-rating score computed entirely
     from local Plex metadata (year + audienceRating, sourced from Rotten Tomatoes per
     the PMS agent) - no external API calls. Replaces an earlier TMDb-trending-based
     version that too often had zero overlap with an older library (trending skews hard
     toward brand-new theatrical releases). Year is normalized against the library's own
     min/max release year, so "recent" is relative to what's actually in the library,
     not calendar time; weighted 50/50 with rating, adjust freely. */
  _buildPopularRaw() {
    const pool = new Map();
    for (const entries of this._genreBySection.values()) {
      for (const g of entries) {
        if (this._isBlockedGenreName(g.title)) continue;
        for (const m of g.items) {
          if (m.ratingKey && !pool.has(m.ratingKey)) pool.set(m.ratingKey, m);
        }
      }
    }
    const eligible = Array.from(pool.values()).filter(
      (m) => typeof m.year === "number" && typeof m.audienceRating === "number"
    );
    if (!eligible.length) return [];
    const years = eligible.map((m) => m.year);
    const minYear = Math.min(...years);
    const yearRange = Math.max(...years) - minYear || 1;
    const scored = eligible.map((m) => {
      const recencyScore = (m.year - minYear) / yearRange;
      const ratingScore = m.audienceRating / 10;
      return { item: m, score: recencyScore * 0.5 + ratingScore * 0.5 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }

  _mapItem(m, withProgress) {
    const thumbPath = m.thumb || m.grandparentThumb || m.composite || m.art || "";
    const image = this._plexImageUrl(thumbPath);
    const art = this._plexImageUrl(m.art || m.grandparentArt || thumbPath);
    const title = m.grandparentTitle || m.title || "Untitled";
    const subtitle = m.grandparentTitle ? m.title : m.year ? String(m.year) : "";
    const item = {
      ratingKey: m.ratingKey,
      key: m.key,
      type: m.type,
      title,
      subtitle,
      image,
      art,
      year: m.year,
      showKey: m.grandparentRatingKey,
      seasonKey: m.parentRatingKey,
      seasonNumber: m.parentIndex,
      episodeNumber: m.index,
      viewCount: m.viewCount || 0,
    };
    if (withProgress && m.duration) {
      item.progress = Math.max(0, Math.min(1, (m.viewOffset || 0) / m.duration));
    }
    return item;
  }

  _slugify(text) {
    return (
      (text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item"
    );
  }

  _isAndroid() {
    return /Android/i.test(navigator.userAgent || "");
  }

  _tapUrl(item, source) {
    if (source === "watchlist" && item.key) {
      return `https://app.plex.tv/desktop/#!/provider/tv.plex.provider.discover/details?key=${encodeURIComponent(item.key)}`;
    }
    if (item.type === "movie" && item.ratingKey && this._isAndroid()) {
      return `plex://libraries/${this._config.machine_id}/movie/${this._slugify(item.title)}/${item.ratingKey}`;
    }
    if (item.type === "show" && item.ratingKey && this._isAndroid()) {
      return `plex://libraries/${this._config.machine_id}/show/${this._slugify(item.title)}/${item.ratingKey}`;
    }
    if (
      item.type === "episode" &&
      item.ratingKey &&
      item.showKey &&
      item.seasonKey &&
      item.seasonNumber != null &&
      item.episodeNumber != null &&
      this._isAndroid()
    ) {
      return `plex://libraries/${this._config.machine_id}/show/${this._slugify(item.title)}/${item.showKey}/s/${item.seasonNumber}/${item.seasonKey}/e/${item.episodeNumber}/${item.ratingKey}`;
    }
    if (item.type === "collection" && item.ratingKey && this._isAndroid()) {
      return `plex://libraries/${this._config.machine_id}/collection/${item.ratingKey}`;
    }
    if (item.type === "playlist" && item.ratingKey && this._isAndroid()) {
      return `plex://libraries/${this._config.machine_id}/playlist/${item.ratingKey}`;
    }
    if (item.type === "collection" && item.ratingKey) {
      return `${this._config.plex_url}/web/index.html#!/server/${this._config.machine_id}/details?key=${encodeURIComponent(
        "/library/collections/" + item.ratingKey
      )}`;
    }
    if (item.type === "playlist" && item.ratingKey) {
      return `${this._config.plex_url}/web/index.html#!/server/${this._config.machine_id}/playlist?key=${encodeURIComponent(
        "/playlists/" + item.ratingKey
      )}`;
    }
    return `${this._config.plex_url}/web/index.html#!/server/${this._config.machine_id}/details?key=${encodeURIComponent(
      "/library/metadata/" + item.ratingKey
    )}`;
  }

  _emptyStateHtml(msg) {
    return `${EMPTY_STATE_ICON_SVG}<div>${this._escape(msg)}</div>`;
  }

  _renderMessage(msg) {
    this._rowsEl.innerHTML = `<div class="message">${this._emptyStateHtml(msg)}</div>`;
  }

  _renderLoading() {
    this._rowsEl.innerHTML = `<div class="loading-wrap"><div class="spinner"></div></div>`;
  }

  _renderRows(rows) {
    this._rowsEl.innerHTML = "";
    if (!rows.length) {
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("Nothing to show yet.")}</div>`;
      return;
    }
    const nth = this._config.landscape_every_nth;
    rows.forEach((row, i) => {
      /* rankNumbers rows are pinned to portrait mode - the rank-number's height is
         tuned against portrait poster height (see .rank-number CSS); the auto-landscape
         cycle below would otherwise occasionally flip this row to much-shorter landscape
         posters and make the number overflow the row's padding. */
      const landscape = row.rankNumbers ? false : !!row.landscape || (!!nth && (i + 1) % nth === 0);
      this._rowsEl.appendChild(this._buildRowSection(row, landscape, i));
    });
  }

  _buildRowSection(row, landscape = false, rowIndex = 0) {
    const section = document.createElement("div");
    section.className = "row-section row-anim-in";
    section.style.animationDelay = `${Math.min(rowIndex, 8) * 45}ms`;
    if (row.source === "watchlist") section.dataset.rowKey = "watchlist";
    const h = document.createElement("div");
    h.className = "row-title";
    h.textContent = row.title;

    const scroller = document.createElement("div");
    scroller.className = "row-scroller";
    row.items.forEach((item, itemIndex) => {
      const poster = this._buildPoster(item, row.source || "local", { landscape, itemIndex });
      if (row.rankNumbers) {
        const wrap = document.createElement("div");
        wrap.className = "rank-item";
        wrap.style.animationDelay = poster.style.animationDelay;
        const num = document.createElement("div");
        num.className = "rank-number";
        num.textContent = String(itemIndex + 1);
        wrap.appendChild(num);
        wrap.appendChild(poster);
        scroller.appendChild(wrap);
      } else {
        scroller.appendChild(poster);
      }
    });

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "row-scroll-wrap";
    const leftArrow = this._buildScrollArrow("left", scroller);
    const rightArrow = this._buildScrollArrow("right", scroller);
    scrollWrap.appendChild(leftArrow);
    scrollWrap.appendChild(scroller);
    scrollWrap.appendChild(rightArrow);
    this._wireArrowVisibility(scroller, leftArrow, rightArrow);

    section.appendChild(h);
    section.appendChild(scrollWrap);
    return section;
  }

  _buildScrollArrow(dir, scroller) {
    const btn = document.createElement("button");
    btn.className = `scroll-arrow ${dir} hidden`;
    btn.type = "button";
    btn.setAttribute("aria-label", dir === "left" ? "Scroll left" : "Scroll right");
    btn.innerHTML =
      dir === "left"
        ? '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const amount = scroller.clientWidth * 0.9 * (dir === "left" ? -1 : 1);
      scroller.scrollBy({ left: amount, behavior: "smooth" });
    });
    return btn;
  }

  _wireArrowVisibility(scroller, leftArrow, rightArrow) {
    const update = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth - 1;
      leftArrow.classList.toggle("hidden", scroller.scrollLeft <= 0);
      rightArrow.classList.toggle("hidden", maxScroll <= 0 || scroller.scrollLeft >= maxScroll);
    };
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    requestAnimationFrame(update);
    setTimeout(update, 300);
  }

  _buildPoster(item, source, { glow = true, landscape = false, itemIndex = null } = {}) {
    const el = document.createElement("div");
    el.className = landscape ? "poster landscape poster-anim-in" : "poster poster-anim-in";
    el.tabIndex = 0;
    if (itemIndex != null) el.style.animationDelay = `${Math.min(itemIndex, 8) * 30}ms`;
    const src = landscape ? item.art || item.image : item.image;
    if (glow) el.style.setProperty("--img", `url('${src}')`);
    const canWatchlist = item.type === "movie" || item.type === "show";
    el.innerHTML = `
      ${glow ? '<div class="glow"></div>' : ""}
      <div class="card">
        <img loading="lazy" src="${src}" alt="${this._escape(item.title)}" />
        <div class="img-spinner"><div class="spinner-sm"></div></div>
        <div class="img-fallback"><div class="badge">${POSTER_FALLBACK_ICON_SVG}</div></div>
        ${
          item.progress != null
            ? `<div class="progress"><div class="bar" style="width:${Math.round(item.progress * 100)}%"></div></div>`
            : ""
        }
        ${
          item.viewCount > 0 && !(item.progress > 0)
            ? `<div class="watched-badge" title="Watched">${WATCHED_ICON_SVG}</div>`
            : ""
        }
        ${
          canWatchlist
            ? `<button type="button" class="watchlist-btn" aria-label="Add to My List">+</button>`
            : ""
        }
        <div class="caption">
          <div class="t">${this._escape(item.title)}</div>
          ${item.subtitle ? `<div class="s">${this._escape(item.subtitle)}</div>` : ""}
        </div>
      </div>
    `;
    if (!src) {
      el.classList.add("img-error");
    } else {
      const img = el.querySelector("img");
      if (img.complete) {
        el.classList.add(img.naturalWidth > 0 ? "img-loaded" : "img-error");
      } else {
        img.addEventListener("load", () => el.classList.add("img-loaded"), { once: true });
        img.addEventListener("error", () => el.classList.add("img-error"), { once: true });
      }
    }
    if (canWatchlist) {
      const watchlistBtn = el.querySelector(".watchlist-btn");
      if (this._isInWatchlist(item)) {
        watchlistBtn.classList.add("added");
        watchlistBtn.textContent = "✓";
        watchlistBtn.setAttribute("aria-label", "Remove from My List");
      }
      watchlistBtn.addEventListener("mouseenter", () => {
        if (watchlistBtn.classList.contains("added")) watchlistBtn.textContent = "−";
      });
      watchlistBtn.addEventListener("mouseleave", () => {
        if (watchlistBtn.classList.contains("added")) watchlistBtn.textContent = "✓";
      });
      watchlistBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (watchlistBtn.classList.contains("added")) {
          this._removeFromWatchlist(item, watchlistBtn);
        } else {
          this._addToWatchlist(item, watchlistBtn);
        }
      });
    }
    el.addEventListener("click", () => {
      this._openTitleInfo(item, source);
    });
    return el;
  }

  /* Local library titles and Plex's cloud Discover titles can differ in punctuation only
     (e.g. local "Dragon Ball Z Bio-Broly" vs Discover "Dragon Ball Z: Bio-Broly") - an exact
     string match silently fails on these, so comparisons strip everything but alphanumerics. */
  _normalizeTitle(t) {
    return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  _isInWatchlist(item) {
    const norm = this._normalizeTitle(item.title);
    return (this._watchlistRaw || []).some(
      (w) => this._normalizeTitle(w.title) === norm && (!item.year || w.year === item.year)
    );
  }

  async _resolveDiscoverRatingKey(item) {
    try {
      const url = new URL("https://discover.provider.plex.tv/library/search");
      url.searchParams.set("query", item.title);
      url.searchParams.set("searchTypes", item.type === "show" ? "tv" : "movies");
      url.searchParams.set("searchProviders", "discover");
      url.searchParams.set("limit", "10");
      url.searchParams.set("X-Plex-Token", this._config.plex_account_token);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      const data = await res.json();
      const results = (data?.MediaContainer?.SearchResults || [])
        .flatMap((g) => g.SearchResult || [])
        .map((r) => r.Metadata)
        .filter(Boolean);
      const norm = this._normalizeTitle(item.title);
      const exact = results.find(
        (m) => this._normalizeTitle(m.title) === norm && (!item.year || m.year === item.year)
      );
      return (exact || results[0])?.ratingKey || null;
    } catch (e) {
      return null;
    }
  }

  /* The reverse of _resolveDiscoverRatingKey: a "My List" item's ratingKey is scoped to
     discover.provider.plex.tv, a different ID space than this server's /library/metadata -
     using it directly there 404s. Resolve the local ratingKey (if the title is actually
     in this server's library) via /hubs/search before fetching detail. */
  async _resolveLocalRatingKey(item) {
    try {
      const data = await this._plexFetch("/hubs/search", { query: item.title, limit: 10 });
      const results = (data?.MediaContainer?.Hub || [])
        .filter((h) => h.type === item.type)
        .flatMap((h) => h.Metadata || []);
      const norm = this._normalizeTitle(item.title);
      const exact = results.find(
        (m) => this._normalizeTitle(m.title) === norm && (!item.year || m.year === item.year)
      );
      return (exact || results[0])?.ratingKey || null;
    } catch (e) {
      return null;
    }
  }

  async _addToWatchlist(item, btnEl) {
    if (btnEl.dataset.busy) return;
    btnEl.dataset.busy = "1";
    btnEl.classList.add("busy");
    try {
      const ratingKey = await this._resolveDiscoverRatingKey(item);
      if (!ratingKey) throw new Error("no discover match");
      const url = new URL("https://discover.provider.plex.tv/actions/addToWatchlist");
      url.searchParams.set("ratingKey", ratingKey);
      url.searchParams.set("X-Plex-Token", this._config.plex_account_token);
      const res = await fetch(url, { method: "PUT", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("add failed");
      btnEl.classList.remove("busy");
      btnEl.classList.add("added");
      btnEl.textContent = "✓";
      btnEl.setAttribute("aria-label", "Remove from My List");
      this._watchlistRaw = await this._fetchWatchlistRaw();
      this._refreshWatchlistRow();
    } catch (e) {
      btnEl.classList.remove("busy");
      btnEl.classList.add("error");
      setTimeout(() => btnEl.classList.remove("error"), 1500);
    } finally {
      delete btnEl.dataset.busy;
    }
  }

  async _removeFromWatchlist(item, btnEl) {
    if (btnEl.dataset.busy) return;
    btnEl.dataset.busy = "1";
    btnEl.classList.add("busy");
    try {
      const ratingKey = await this._resolveDiscoverRatingKey(item);
      if (!ratingKey) throw new Error("no discover match");
      const url = new URL("https://discover.provider.plex.tv/actions/removeFromWatchlist");
      url.searchParams.set("ratingKey", ratingKey);
      url.searchParams.set("X-Plex-Token", this._config.plex_account_token);
      const res = await fetch(url, { method: "PUT", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("remove failed");
      btnEl.classList.remove("busy", "added");
      btnEl.textContent = "+";
      btnEl.setAttribute("aria-label", "Add to My List");
      this._watchlistRaw = await this._fetchWatchlistRaw();
      this._refreshWatchlistRow();
    } catch (e) {
      btnEl.classList.remove("busy");
      btnEl.classList.add("error");
      setTimeout(() => btnEl.classList.remove("error"), 1500);
    } finally {
      delete btnEl.dataset.busy;
    }
  }

  _onSearchInput() {
    clearTimeout(this._searchTimer);
    const q = this._searchInput.value.trim();
    if (!q) {
      this._exitSearch();
      return;
    }
    if (this._currentView !== "search") this._enterSearch();
    this._searchTimer = setTimeout(() => this._runSearch(q), 300);
  }

  _enterSearch() {
    this._preSearchView = this._currentView;
    this._currentView = "search";
    this._navItems.forEach((n) => n.classList.remove("active"));
    this._showHero();
    this._renderLoading();
  }

  _exitSearch() {
    if (this._currentView !== "search") return;
    this._currentView = this._preSearchView || "home";
    this._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === this._currentView));
    this._renderCurrentView();
    this._advanceHero();
  }

  async _runSearch(q) {
    try {
      const hubs = await this._buildSearchHubs(q, SEARCH_HUB_LIMIT, this._config.row_size);
      if (this._currentView !== "search") return;
      this._lastSearchQuery = q;
      this._lastSearchHubs = hubs;
      this._renderSearchPage(hubs);
    } catch (e) {
      if (this._currentView !== "search") return;
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("Search failed")}</div>`;
    }
  }

  /* Shared by both the normal (capped) search page and "See All" section expansion -
     the two differ only in the limits passed to Plex's hub search and to the
     locally-built genre/year/facet hubs. */
  async _buildSearchHubs(q, hubLimit, rowLimit) {
    /* /hubs/search ignores X-Plex-Container-Size for its per-hub result count (silently
       caps at 3 regardless of that value) - the real per-hub limit param is `limit`,
       confirmed empirically. */
    const data = await this._plexFetch("/hubs/search", { query: q, limit: hubLimit });
    const hubs = (data?.MediaContainer?.Hub || []).filter((h) => (h.Metadata || []).length);
    const reasonHubs = this._buildReasonMatchHubs(hubs, hubLimit);
    const otherHubs = hubs
      .map((h) => {
        const rawLen = (h.Metadata || []).length;
        return {
          ...h,
          Metadata: (h.Metadata || []).filter((m) => !SEARCH_REASON_LABELS[m.reason]),
          /* /hubs/search DOES honor `limit` (unlike X-Plex-Container-Size elsewhere), so
             hitting it exactly is a reliable "there may be more" signal - there's no
             per-hub totalSize in this response to check precisely. */
          hasMore: rawLen >= hubLimit,
        };
      })
      .filter((h) => h.Metadata.length);
    const genreHubs = this._buildGenreMatchHubs(q, rowLimit);
    const yearHubs = await this._buildYearMatchHubs(q, rowLimit);
    const facetHubs = await this._buildFacetMatchHubs(q, rowLimit);
    return [...otherHubs, ...reasonHubs, ...genreHubs, ...yearHubs, ...facetHubs];
  }

  async _expandSearchSection(title) {
    const q = this._lastSearchQuery;
    if (!q) return;
    this._renderLoading();
    try {
      const hubs = await this._buildSearchHubs(q, SEARCH_EXPAND_LIMIT, SEARCH_EXPAND_LIMIT);
      if (this._currentView !== "search") return;
      const hub = hubs.find((h) => h.title === title);
      this._renderSearchPage(hub ? [hub] : [], { expanded: true });
    } catch (e) {
      if (this._currentView !== "search") return;
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("Search failed")}</div>`;
    }
  }

  _buildGenreMatchHubs(query, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const merged = new Map();
    for (const entries of this._genreBySection.values()) {
      for (const g of entries) {
        if (!g.title.toLowerCase().includes(q)) continue;
        if (this._isBlockedGenreName(g.title)) continue;
        const norm = g.title.trim().toLowerCase();
        if (!merged.has(norm)) merged.set(norm, { title: g.title, items: [] });
        merged.get(norm).items.push(...g.items);
      }
    }
    return Array.from(merged.values())
      .filter((g) => g.items.length)
      .map((g) => ({
        title: `Genre "${g.title}"`,
        Metadata: [...g.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, limit),
        hasMore: g.items.length > limit,
      }));
  }

  _parseYearQuery(query) {
    const q = query.trim();
    if (/^(19|20)\d{2}$/.test(q)) {
      const y = parseInt(q, 10);
      return [y, y];
    }
    const m = q.match(/^((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})$/);
    if (!m) return null;
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    return a <= b ? [a, b] : [b, a];
  }

  async _buildYearMatchHubs(query, limit) {
    const range = this._parseYearQuery(query);
    if (!range) return [];
    const [start, end] = range;
    /* Plex's advanced filter operators (>>/<< on the field name) are strict
       inequalities, so an inclusive range needs the bounds nudged by one -
       confirmed empirically against this server (year>>1989&year<<1996 returns
       exactly 1990-1995). */
    const yearParams = start === end ? { year: start } : { "year>>": start - 1, "year<<": end + 1 };
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
            type: s.type,
            "X-Plex-Container-Size": limit,
            ...yearParams,
          });
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    const items = perSection.flat();
    if (!items.length) return [];
    const title = start === end ? `Year ${start}` : `Year ${start}–${end}`;
    /* X-Plex-Container-Size is silently ignored on /library/sections/{key}/all (confirmed
       empirically, same as the /hubs/search quirk noted above) - Plex already returned
       the full matching set here, so `items.length` is the true total, not just what
       got requested, and the slice below is the only thing actually capping this row. */
    return [{ title, Metadata: items.slice(0, limit), hasMore: items.length > limit }];
  }

  async _buildFacetMatchHubs(query, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matchFacets = (facets) => (facets || []).filter((f) => f.title.toLowerCase().includes(q));
    const jobs = [
      ...matchFacets(this._studioFacets).map((facet) => ({ facet, filterName: "studio", label: "Studio" })),
      ...matchFacets(this._collectionFacets).map((facet) => ({ facet, filterName: "collection", label: "Collection" })),
    ];
    const hubs = await Promise.all(
      jobs.map(async ({ facet, filterName, label }) => {
        const items = await this._fetchByFacet(facet, filterName, limit);
        /* _fetchByFacet already returns everything Plex has for this facet (see its
           comment - X-Plex-Container-Size is ignored server-side and nothing slices
           the result afterward), so there's never anything left to reveal via "See All". */
        if (!items.length) return null;
        const hub = { title: `${label} "${facet.title}"`, Metadata: items, hasMore: false };
        if (filterName === "collection") {
          /* facet comes from the singular /collection facet-listing endpoint, which has
             no thumb - look the real poster up by title from the plural /collections
             fetch (_fetchCollectionsRaw) instead, matched within the same section. */
          const match = (this._collectionsRaw || []).find(
            (c) => c.section.key === facet.section.key && c.title === facet.title
          );
          if (match?.thumb) hub.image = this._plexImageUrl(match.thumb);
        }
        return hub;
      })
    );
    return hubs.filter(Boolean);
  }

  async _fetchByFacet(facet, filterName, limit) {
    try {
      /* facet.key comes back from Plex's own /studio and /collection directory listings
         already percent-escaped for direct reuse as a filter value (double-escaped for
         studio names with spaces, e.g. "Marvel%2520Studios") - it must be appended to the
         URL as-is, not passed through URLSearchParams/searchParams.set, which would
         re-encode the literal "%" characters and break the match. */
      const base = new URL(`${this._config.plex_url}/library/sections/${facet.section.key}/all`);
      base.searchParams.set("type", facet.section.type);
      base.searchParams.set("X-Plex-Container-Size", limit);
      base.searchParams.set("X-Plex-Token", this._config.plex_token);
      const res = await fetch(`${base.toString()}&${filterName}=${facet.key}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  _buildReasonMatchHubs(hubs, hubLimit) {
    const byReason = new Map();
    for (const hub of hubs) {
      /* Reason-matched rows are carved out of a hub /hubs/search already truncated to
         hubLimit - if that source hub was capped, some actor/director matches could be
         sitting past the cutoff, so treat every reason group sourced from it as
         possibly incomplete too (can't tell more precisely without a per-actor fetch). */
      const hubCapped = (hub.Metadata || []).length >= hubLimit;
      for (const m of hub.Metadata || []) {
        const label = SEARCH_REASON_LABELS[m.reason];
        if (!label || !m.reasonTitle) continue;
        const key = `${m.reason}:${m.reasonTitle}`;
        if (!byReason.has(key)) byReason.set(key, { label, name: m.reasonTitle, items: [], hasMore: false });
        const entry = byReason.get(key);
        entry.items.push(m);
        if (hubCapped) entry.hasMore = true;
      }
    }
    return Array.from(byReason.values()).map(({ label, name, items, hasMore }) => ({
      title: `${label} "${name}"`,
      Metadata: items,
      hasMore,
    }));
  }

  _renderSearchPage(hubs, { expanded = false } = {}) {
    /* Filtered here rather than at each hub-building function (reason/genre/year/facet
       hubs all funnel through this one render call) so Kids Mode covers search with a
       single change, and re-rendering from the cached _lastSearchHubs (Back button,
       or a Kids Mode toggle mid-search) always re-applies the current filter live. */
    const visibleHubs = hubs
      .map((hub) => ({ ...hub, Metadata: (hub.Metadata || []).filter((m) => this._passesKidsMode(m)) }))
      .filter((hub) => hub.Metadata.length);
    if (!visibleHubs.length) {
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("No results")}</div>`;
      return;
    }
    const page = document.createElement("div");
    page.className = "search-page";
    if (expanded) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "search-page-back";
      back.textContent = "← Back to all results";
      back.addEventListener("click", () => {
        if (this._lastSearchHubs) this._renderSearchPage(this._lastSearchHubs);
      });
      page.appendChild(back);
    }
    for (const hub of visibleHubs) {
      const group = document.createElement("div");
      group.className = "search-page-group";
      const header = document.createElement("div");
      header.className = "search-page-group-header";
      const h = document.createElement("div");
      h.className = "search-page-group-title";
      h.textContent = hub.title;
      if (hub.image) {
        const titleWrap = document.createElement("div");
        titleWrap.className = "search-page-group-title-wrap";
        const img = document.createElement("img");
        img.className = "search-page-group-image";
        img.src = hub.image;
        img.alt = "";
        titleWrap.appendChild(img);
        titleWrap.appendChild(h);
        header.appendChild(titleWrap);
      } else {
        header.appendChild(h);
      }
      if (!expanded && hub.hasMore) {
        const seeAll = document.createElement("button");
        seeAll.type = "button";
        seeAll.className = "search-page-see-all";
        seeAll.textContent = "See All";
        seeAll.addEventListener("click", () => this._expandSearchSection(hub.title));
        header.appendChild(seeAll);
      }
      group.appendChild(header);
      const grid = document.createElement("div");
      grid.className = "search-page-grid";
      for (const m of hub.Metadata || []) {
        const item = this._mapItem(m, false);
        grid.appendChild(this._buildPoster(item, "local"));
      }
      group.appendChild(grid);
      page.appendChild(group);
    }
    this._rowsEl.innerHTML = "";
    this._rowsEl.appendChild(page);
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
}

if (!customElements.get("plex-netflix-card")) {
  customElements.define("plex-netflix-card", PlexNetflixCard);
  console.info(
    "%c PLEX-NETFLIX-CARD %c v1.0.0-standalone ",
    "color:white;background:#e5a00d;font-weight:bold;",
    "color:#e5a00d;background:#222;font-weight:bold;"
  );
}
