/* Virtual horizontal scrolling for a .row-scroller/.row-track pair (see rows.js/nav.js).

   Xbox's WebView2 has its own built-in gamepad-to-scroll handling that acts directly on any
   native overflow:auto container, completely independent of any DOM event or UWP-level
   setting this app can intercept (confirmed on real hardware - host-reset.css's own history
   comment covers the same discovery for the page-level scroll container). A natively-
   scrolling .row-scroller was exactly such a container: browsing a genre row with the left
   stick fought this module's own discrete poster-centering scrollIntoView calls, producing
   visible jitter/drift that never settled centered. Moving to a transform-driven track that
   only this module ever writes to removes the native scroll surface entirely - there's
   nothing left for WebView2 to hijack.

   scroller: the clipping viewport (overflow:hidden, owns the row's padding).
   track: the flex row of posters inside it (owns the transform). */

const ANIMATE_MS = 300;
const DRAG_THRESHOLD_PX = 4;
/* Momentum tuning: VELOCITY_SAMPLE_MS is the trailing window used to estimate release
   velocity (so one slow final pixel right before lift-off can't zero out a fast flick).
   FRICTION is the fraction of velocity kept per 16.7ms frame - ~0.94 gives a glide that
   settles in a bit under a second, close to the native overflow-scroll feel this replaced.
   MIN_FLING_PX_MS is the release-velocity floor below which no momentum kicks in at all
   (a slow deliberate drag should just stop where the finger lifted, not drift). */
const VELOCITY_SAMPLE_MS = 100;
const FRAME_MS = 16.6667;
const FRICTION = 0.94;
const MIN_FLING_PX_MS = 0.05;
const MIN_MOMENTUM_PX_MS = 0.02;

export function createRowScroll(scroller, track) {
  let offset = 0;
  const listeners = new Set();

  function contentWidth() {
    const cs = getComputedStyle(scroller);
    return scroller.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  }

  function maxOffset() {
    return Math.max(0, track.scrollWidth - contentWidth());
  }

  function clamp(v) {
    return Math.max(0, Math.min(maxOffset(), v));
  }

  function apply(next, { animate = true } = {}) {
    offset = clamp(next);
    track.style.transition = animate ? `transform ${ANIMATE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    const max = maxOffset();
    listeners.forEach((fn) => fn(offset, max));
  }

  function scrollBy(delta, opts) {
    stopMomentum();
    apply(offset + delta, opts);
  }

  /* Mirrors Element.scrollIntoView's inline option but only ever moves this row's own
     track - the caller still separately handles block-axis (vertical, page-level)
     centering via the real scrollIntoView (see nav.js's focusPoster). Computed from live
     bounding rects (not cached CSS padding math) so it's correct regardless of the
     track's current transform. */
  function scrollIntoView(child, { inline = "center", animate = false } = {}) {
    const cRect = child.getBoundingClientRect();
    const sRect = scroller.getBoundingClientRect();
    const cs = getComputedStyle(scroller);
    const viewLeft = sRect.left + (parseFloat(cs.paddingLeft) || 0);
    const viewRight = sRect.right - (parseFloat(cs.paddingRight) || 0);
    let delta = 0;
    if (inline === "center") {
      delta = (cRect.left + cRect.right) / 2 - (viewLeft + viewRight) / 2;
    } else {
      if (cRect.left < viewLeft) delta = cRect.left - viewLeft;
      else if (cRect.right > viewRight) delta = cRect.right - viewRight;
    }
    if (delta !== 0) {
      stopMomentum();
      apply(offset + delta, { animate });
    }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getState() {
    return { offset, max: maxOffset() };
  }

  /* Re-clamps against the track/viewport's current size (e.g. after a window resize) and
     re-notifies listeners even when the offset itself doesn't change - arrow visibility
     depends on `max` too, which can shift without `offset` moving at all. */
  function refresh() {
    offset = clamp(offset);
    track.style.transition = "none";
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    const max = maxOffset();
    listeners.forEach((fn) => fn(offset, max));
  }

  // --- momentum (post-release glide, mirrors native overflow-scroll's fling) ---
  let momentumRAF = null;

  function stopMomentum() {
    if (momentumRAF != null) {
      cancelAnimationFrame(momentumRAF);
      momentumRAF = null;
    }
  }

  function startMomentum(velocity) {
    // velocity is in offset-px/ms already (see endDrag) - positive scrolls toward the end.
    if (Math.abs(velocity) < MIN_FLING_PX_MS) return;
    let v = velocity;
    let lastT = performance.now();
    const step = (t) => {
      const dt = t - lastT;
      lastT = t;
      const next = clamp(offset + v * dt);
      if (next === offset || Math.abs(v) < MIN_MOMENTUM_PX_MS) {
        momentumRAF = null;
        return;
      }
      apply(next, { animate: false });
      v *= Math.pow(FRICTION, dt / FRAME_MS);
      momentumRAF = requestAnimationFrame(step);
    };
    momentumRAF = requestAnimationFrame(step);
  }

  // --- mouse/touch drag ---
  let drag = null;
  scroller.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    stopMomentum();
    drag = { startX: e.clientX, startOffset: offset, moved: false, pointerId: e.pointerId, samples: [{ t: e.timeStamp, x: e.clientX }] };
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      scroller.setPointerCapture(drag.pointerId);
      scroller.classList.add("dragging");
    }
    drag.samples.push({ t: e.timeStamp, x: e.clientX });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > VELOCITY_SAMPLE_MS) drag.samples.shift();
    if (drag.moved) {
      apply(drag.startOffset - dx, { animate: false });
      e.preventDefault();
    }
  });
  function endDrag() {
    if (!drag) return;
    if (drag.moved) {
      scroller.classList.remove("dragging");
      // Swallow the click a drag-release would otherwise fire on whatever poster it lands
      // on - same "don't treat a drag as a tap" rule native overflow scrolling gives for free.
      scroller.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
      const first = drag.samples[0];
      const last = drag.samples[drag.samples.length - 1];
      const dt = last.t - first.t;
      // Offset moves opposite to finger travel (see the apply() call above), so negate.
      if (dt > 0) startMomentum(-(last.x - first.x) / dt);
    }
    drag = null;
  }
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);

  /* Deliberately no wheel handling here. A native overflow-x:auto row would have redirected
     a plain vertical mouse-wheel scroll into horizontal row movement (the standard "only
     one axis scrolls, so wheel goes there" browser behavior) - annoying with a real mouse,
     since hovering any row while trying to scroll the page down did nothing to the page.
     Rows are still fully browsable without a wheel: drag (above), the arrow buttons, and
     D-pad/gamepad/keyboard nav. Leaving wheel events alone lets them bubble untouched to
     .content, which scrolls the page vertically like anywhere else on it. */

  return { scrollBy, scrollIntoView, onChange, getState, refresh };
}
