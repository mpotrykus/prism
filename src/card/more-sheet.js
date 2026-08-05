/* Mobile-only overflow sheet for the bottom nav bar - collects whichever nav rows the
   card decides don't fit (see the card's own _renderMoreSheet for which those are) and
   renders them as a plain list, delegating each tap back to the row's own onSelect. */
export function renderMoreSheet(moreListEl, rows, escape) {
  moreListEl.innerHTML = rows
    .map(
      (r) => `
        <button type="button" class="more-sheet-item${r.active ? " active" : ""}" tabindex="0">
          <span class="more-sheet-item-icon">${r.iconHTML}</span>
          <span>${escape(r.label)}</span>
        </button>`
    )
    .join("");
  moreListEl.querySelectorAll(".more-sheet-item").forEach((btn, i) => {
    btn.addEventListener("click", () => rows[i].onSelect());
  });
}
