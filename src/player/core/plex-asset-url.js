/* Same query-param-token URL shape plex-netflix-card.js's _plexImageUrl uses (see that
   file's CORS note - a header token makes Plex fail the preflight). Shared by chrome.js
   (chapter thumbs, scrub-preview) and native-bridge.js (same two things, handed to
   Android instead of fetched here) so both platforms build this URL identically instead
   of drifting. */
export function plexAssetUrl(session, path) {
    if (!path || !session?.plexUrl) return null;
    const sep = path.includes("?") ? "&" : "?";
    return `${session.plexUrl}${path}${sep}X-Plex-Token=${session.plexToken}`;
}
