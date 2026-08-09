/* Row/poster rendering: turning the row shapes logic/catalog.js builds into actual
   scrollable DOM. Kept as plain DOM-factory functions taking an explicit ctx (escape,
   watchlist state/actions, open-title-info callback) rather than methods on the card,
   so this has no hidden dependency on the rest of the card's state. */

const POSTER_FALLBACK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="5.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.4" cy="9.3" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.4" cy="14.7" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="6.6" cy="14.7" r="1.3" fill="currentColor" stroke="none"/><circle cx="6.6" cy="9.3" r="1.3" fill="currentColor" stroke="none"/></svg>';

export const EMPTY_STATE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="10.5" cy="10.5" r="7"/><path d="M20 20l-4.8-4.8" stroke-linecap="round"/></svg>';
export const WATCHED_ICON_SVG =
  '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Row rebuilds (search exit, profile switch, ...) wipe and recreate every
   poster via innerHTML. Reusing the same <img> node (rather than a fresh one with the same
   src) guarantees the browser can't issue a second network request for a poster already on
   screen - a new element with an identical src is only a *likely* cache hit, not a guaranteed
   one. Keyed by src, unbounded for app lifetime - library-sized, not worth evicting.

   The same title can legitimately appear in more than one row at once (Continue Watching,
   a genre row, Watchlist, ...) - a DOM node only exists in one place, so handing out the
   literal cached node to a second concurrent poster would rip it out of the first one,
   leaving it blank. Only reuse the cached node when it's actually free (detached, e.g. after
   a full-row wipe); otherwise clone it - cloning an already-loaded <img> is a browser
   memory-cache hit, not a real fetch, so it doesn't defeat the point of the cache. */
const posterImgCache = new Map();

function getPosterImg(src, alt) {
  let img = posterImgCache.get(src);
  if (!img) {
    img = document.createElement("img");
    img.loading = "lazy";
    img.src = src;
    posterImgCache.set(src, img);
  } else if (img.isConnected) {
    img = img.cloneNode();
  }
  img.alt = alt;
  return img;
}

export function emptyStateHtml(msg, escape) {
  return `${EMPTY_STATE_ICON_SVG}<div>${escape(msg)}</div>`;
}

export function renderMessage(rowsEl, msg, escape) {
  rowsEl.innerHTML = `<div class="message">${emptyStateHtml(msg, escape)}</div>`;
}

export function renderLoading(rowsEl) {
  rowsEl.innerHTML = `<div class="loading-wrap"><div class="spinner"></div></div>`;
}

/* Small inline spinner pinned to the end of the rows list while the background wave
   (see data.js's loadBackgroundData) is still fetching genre/collection/AI rows -
   distinct from renderLoading's full-page spinner, which only ever applies before the
   very first render. renderRows' merge mode inserts newly-arrived rows before this node
   (see below) so it always stays pinned to the bottom, not wherever the last row
   happened to land. */
export function showLoadingMore(rowsEl) {
  if (rowsEl.querySelector(".rows-loading-more")) return;
  const el = document.createElement("div");
  el.className = "rows-loading-more";
  el.innerHTML = `<div class="spinner"></div>`;
  rowsEl.appendChild(el);
}

export function hideLoadingMore(rowsEl) {
  rowsEl.querySelector(".rows-loading-more")?.remove();
}

export function buildScrollArrow(dir, scroller) {
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

export function wireArrowVisibility(scroller, leftArrow, rightArrow) {
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

/* ctx: { escape, isInWatchlist, paintWatchlistButton, onAddToWatchlist, onRemoveFromWatchlist, onOpenTitleInfo } */
export function buildPoster(item, source, { glow = true, landscape = false, itemIndex = null } = {}, ctx) {
  const el = document.createElement("div");
  el.className = landscape ? "poster landscape poster-anim-in" : "poster poster-anim-in";
  el.tabIndex = 0;
  /* Lets a watch-state change (mark unwatched, playback ending) find and live-patch
     every rendered copy of this title's poster (the same title can legitimately appear
     in more than one row at once - see the comment above) without needing a full
     _renderCurrentView() re-render, which would also reset the hero trailer. */
  if (item.ratingKey != null) el.dataset.ratingKey = item.ratingKey;
  if (itemIndex != null) el.style.animationDelay = `${Math.min(itemIndex, 8) * 30}ms`;
  const src = landscape ? item.art || item.image : item.image;
  const canWatchlist = item.type === "movie" || item.type === "show";
  el.innerHTML = `
    ${glow ? '<div class="glow"></div>' : ""}
    <div class="card">
      <div class="img-spinner"><div class="spinner-sm"></div></div>
      <div class="img-fallback"><div class="badge">${POSTER_FALLBACK_ICON_SVG}</div></div>
      ${
        item.progress != null
          ? `<div class="progress"><div class="bar" style="width:${Math.round(item.progress * 100)}%"></div></div>`
          : ""
      }
      ${
        item.watched && !(item.progress > 0)
          ? `<div class="watched-badge" title="Watched">${WATCHED_ICON_SVG}</div>`
          : ""
      }
      ${
        canWatchlist
          ? `<button type="button" class="watchlist-btn" aria-label="Add to My List">+</button>`
          : ""
      }
      <div class="caption">
        <div class="t">${ctx.escape(item.title)}</div>
        ${item.subtitle ? `<div class="s">${ctx.escape(item.subtitle)}</div>` : ""}
      </div>
    </div>
  `;
  if (!src) {
    el.classList.add("img-error");
  } else {
    const img = getPosterImg(src, item.title);
    el.querySelector(".card").prepend(img);
    /* --img (the blurred .glow halo's background-image) is set only once the poster's
       own <img> has actually loaded, not eagerly at build time - a CSS background-image
       isn't subject to the <img>'s loading="lazy", so setting it upfront for every
       poster in every row (most never scrolled into view) was firing a real network
       fetch for every single poster on the page immediately, defeating lazy-loading
       entirely (confirmed empirically: a cold Home load fired ~378 image requests with
       zero scrolling). Piggybacking on the img's own load event reuses that same
       already-fetched src - no second request - and naturally inherits its lazy timing. */
    const markLoaded = () => {
      if (glow) el.style.setProperty("--img", `url('${src}')`);
      el.classList.add("img-loaded");
    };
    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else el.classList.add("img-error");
    } else {
      img.addEventListener("load", markLoaded, { once: true });
      img.addEventListener("error", () => el.classList.add("img-error"), { once: true });
    }
  }
  if (canWatchlist) {
    const watchlistBtn = el.querySelector(".watchlist-btn");
    if (ctx.isInWatchlist(item)) ctx.paintWatchlistButton(watchlistBtn, true);
    watchlistBtn.addEventListener("mouseenter", () => {
      if (watchlistBtn.classList.contains("added")) watchlistBtn.textContent = "−";
    });
    watchlistBtn.addEventListener("mouseleave", () => {
      if (watchlistBtn.classList.contains("added")) watchlistBtn.textContent = "✓";
    });
    watchlistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (watchlistBtn.classList.contains("added")) {
        ctx.onRemoveFromWatchlist(item, watchlistBtn);
      } else {
        ctx.onAddToWatchlist(item, watchlistBtn);
      }
    });
  }
  el.addEventListener("click", () => {
    ctx.onOpenTitleInfo(item, source);
  });
  return el;
}

export function buildRowSection(row, landscape, rowIndex, ctx) {
  const section = document.createElement("div");
  section.className = "row-section row-anim-in";
  section.style.animationDelay = `${Math.min(rowIndex, 8) * 45}ms`;
  if (row.source === "watchlist") section.dataset.rowKey = "watchlist";
  if (row.title === "Continue Watching") section.dataset.rowKey = "on-deck";
  const h = document.createElement("div");
  h.className = "row-title";
  h.textContent = row.title;

  const scroller = document.createElement("div");
  scroller.className = "row-scroller";
  row.items.forEach((item, itemIndex) => {
    const poster = buildPoster(item, row.source || "local", { landscape, itemIndex }, ctx);
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
  const leftArrow = buildScrollArrow("left", scroller);
  const rightArrow = buildScrollArrow("right", scroller);
  scrollWrap.appendChild(leftArrow);
  scrollWrap.appendChild(scroller);
  scrollWrap.appendChild(rightArrow);
  wireArrowVisibility(scroller, leftArrow, rightArrow);

  section.appendChild(h);
  section.appendChild(scrollWrap);
  return section;
}

/* merge: true (background data streaming in after first paint - see data.js's
   loadBackgroundData) never touches rows already on screen: no wipe, no reordering, no
   removal - only rows whose title isn't already rendered get appended. Scroll position,
   in-flight images, and the anim-in classes on existing rows are left alone, so newly-
   available rows just quietly show up instead of the whole shelf appearing to reload. A
   row can in principle stop being part of the "true" desired set on a later pass (e.g.
   once AI rows compete for _getGenreRowsForView's capped shuffle) - it stays visible
   anyway rather than yanking already-seen content out from under the user. */
export function renderRows(rowsEl, rows, landscapeEveryNth, ctx, { merge = false } = {}) {
  if (!merge) {
    rowsEl.innerHTML = "";
    if (!rows.length) {
      rowsEl.innerHTML = `<div class="empty">${emptyStateHtml("Nothing to show yet.", ctx.escape)}</div>`;
      return;
    }
  } else {
    rowsEl.querySelector(".empty")?.remove();
  }
  const existingTitles = merge
    ? new Set(Array.from(rowsEl.querySelectorAll(".row-title")).map((el) => el.textContent))
    : null;
  /* Keep the loading-more spinner (if any) pinned to the very end - inserting newly-
     merged rows ahead of it rather than appending after it. */
  const loadingMoreEl = merge ? rowsEl.querySelector(".rows-loading-more") : null;
  rows.forEach((row, i) => {
    if (existingTitles?.has(row.title)) return;
    /* rankNumbers rows are pinned to portrait mode - the rank-number's height is tuned
       against portrait poster height (see .rank-number CSS); the auto-landscape cycle
       below would otherwise occasionally flip this row to much-shorter landscape
       posters and make the number overflow the row's padding. */
    const landscape = row.rankNumbers ? false : !!row.landscape || (!!landscapeEveryNth && (i + 1) % landscapeEveryNth === 0);
    const section = buildRowSection(row, landscape, i, ctx);
    if (loadingMoreEl) rowsEl.insertBefore(section, loadingMoreEl);
    else rowsEl.appendChild(section);
  });
}
