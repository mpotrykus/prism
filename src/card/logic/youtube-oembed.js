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
   against a missing/malformed ratio rather than producing NaN/Infinity.

   `tolerance` absorbs oEmbed's own imprecision, not just genuine near-16:9 videos -
   oEmbed only ever returns tiny integer pixel dimensions (200x113, 356x200, ...), so a
   truly-exact 16:9 video can still come back a percent or two off from quantization alone
   (confirmed against a real title: Avengers: Endgame's actual trailer reported 1.0044
   without this, a meaningless micro-zoom). Real non-16:9 containers (4:3 is ~33% off,
   even the mildest theatrical ratios are several percent off) are nowhere near this
   threshold, so nothing genuine gets missed by ignoring noise this small. */
export function computeCoverScale(videoRatio, wrapRatio = 16 / 9, tolerance = 0.02) {
  if (!videoRatio || !isFinite(videoRatio) || videoRatio <= 0) return 1;
  const scale = Math.max(wrapRatio, videoRatio) / Math.min(wrapRatio, videoRatio);
  return scale <= 1 + tolerance ? 1 : scale;
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
