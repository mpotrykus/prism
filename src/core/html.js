const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/* Every innerHTML template in the app interpolates through this. Null/undefined collapse to
   an empty string rather than the literal "null" - Plex metadata fields are routinely
   absent. */
export function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
