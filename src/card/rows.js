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

export function emptyStateHtml(msg, escape) {
  return `${EMPTY_STATE_ICON_SVG}<div>${escape(msg)}</div>`;
}

export function renderMessage(rowsEl, msg, escape) {
  rowsEl.innerHTML = `<div class="message">${emptyStateHtml(msg, escape)}</div>`;
}

export function renderLoading(rowsEl) {
  rowsEl.innerHTML = `<div class="loading-wrap"><div class="spinner"></div></div>`;
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
  if (itemIndex != null) el.style.animationDelay = `${Math.min(itemIndex, 8) * 30}ms`;
  const src = landscape ? item.art || item.image : item.image;
  if (glow) el.style.setProperty("--img", `url('${src}')`);
  const canWatchlist = item.type === "movie" || item.type === "show";
  el.innerHTML = `
    ${glow ? '<div class="glow"></div>' : ""}
    <div class="card">
      <img loading="lazy" src="${src}" alt="${ctx.escape(item.title)}" />
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
        <div class="t">${ctx.escape(item.title)}</div>
        ${item.subtitle ? `<div class="s">${ctx.escape(item.subtitle)}</div>` : ""}
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

export function renderRows(rowsEl, rows, landscapeEveryNth, ctx) {
  rowsEl.innerHTML = "";
  if (!rows.length) {
    rowsEl.innerHTML = `<div class="empty">${emptyStateHtml("Nothing to show yet.", ctx.escape)}</div>`;
    return;
  }
  rows.forEach((row, i) => {
    /* rankNumbers rows are pinned to portrait mode - the rank-number's height is tuned
       against portrait poster height (see .rank-number CSS); the auto-landscape cycle
       below would otherwise occasionally flip this row to much-shorter landscape
       posters and make the number overflow the row's padding. */
    const landscape = row.rankNumbers ? false : !!row.landscape || (!!landscapeEveryNth && (i + 1) % landscapeEveryNth === 0);
    rowsEl.appendChild(buildRowSection(row, landscape, i, ctx));
  });
}
