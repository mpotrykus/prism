/* YouTube's public oEmbed endpoint is the only way available to Prism (short of loading
   the full iframe_api) to learn a trailer's real native aspect ratio before deciding
   whether the default 16:9 "cover" sizing (hero.css's .hero-yt-wrap) needs a corrective
   zoom. Most trailers are already ~16:9 and need no correction - this only matters for
   older/lower-quality uploads (confirmed against a real title - Trigun's only TMDB-listed
   trailer is a 360p, non-official upload of a natively-4:3 source) whose video YouTube's
   own embedded player then pillarboxes/letterboxes *inside* the iframe to preserve -
   something no outer-box CSS can reach, since it's rendered by YouTube's own cross-origin
   document. Aspect ratios are cached indefinitely in localStorage (a video's own ratio
   never changes) keyed by video id. */
const CACHE_KEY = "prism.youtubeAspectCache";

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // best-effort - a full/unavailable localStorage just means no caching this session
  }
}

/* The extra scale factor needed on top of the default 16:9 "cover" sizing so the video's
   own content - not the black bars YouTube pads a non-16:9 upload with - actually fills
   the frame, cropping the overflow via the same ancestor overflow:hidden the base 16:9
   case already relies on. 1 (a no-op) whenever the video is already ~wrapRatio, and safe
   against a missing/malformed ratio rather than producing NaN/Infinity. */
export function computeCoverScale(videoRatio, wrapRatio = 16 / 9) {
  if (!videoRatio || !isFinite(videoRatio) || videoRatio <= 0) return 1;
  return Math.max(wrapRatio, videoRatio) / Math.min(wrapRatio, videoRatio);
}

/* Resolves (and caches) a YouTube video's native width/height ratio via oEmbed. Never
   throws - any failure (network, malformed response) resolves to null so callers can just
   fall back to the default 1x (assume-16:9) sizing, same graceful-degradation contract as
   the rest of the trailer pipeline. */
export async function getYoutubeAspectRatio(videoId) {
  if (!videoId) return null;
  const cache = readCache();
  if (typeof cache[videoId] === "number") return cache[videoId];
  try {
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("format", "json");
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.width || !data?.height) return null;
    const ratio = data.width / data.height;
    cache[videoId] = ratio;
    writeCache(cache);
    return ratio;
  } catch (e) {
    return null;
  }
}
