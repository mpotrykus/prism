/* Shared by every full-viewport overlay (the player, the title-info modal, and any
   future one) that covers the page but doesn't replace it - without this, <html>
   stays scrollable behind a position:fixed overlay whose own content is taller than
   the viewport, showing a second, independent scrollbar/scroll gesture for the hidden
   page underneath. Reference-counted so an overlay opened from within another already-
   locked overlay (e.g. title-info's quality picker) doesn't unlock scroll out from
   under its parent when it closes first. */
let depth = 0;
let prevOverflow = "";

export function lockScroll() {
    if (depth === 0) prevOverflow = document.documentElement.style.overflow;
    depth++;
    document.documentElement.style.overflow = "hidden";
}

export function unlockScroll() {
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.documentElement.style.overflow = prevOverflow;
}
