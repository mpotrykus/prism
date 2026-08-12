/* opensubtitles.js

   Plain client-side calls to the OpenSubtitles REST API (api.opensubtitles.com/api/v1),
   same no-proxy pattern as the existing YouTube/OpenRouter integrations - credentials
   live in settings.js/vault.js like those do. This is the opt-in alternative to the
   default Plex-brokered path (plex-subtitles.js) - selected via Settings' Subtitle
   Provider dropdown, dispatched by src/player/core/subtitle-provider.js. Trades "no
   credentials on this client" for "zero extra load on PMS", since every search/download
   here goes straight to OpenSubtitles instead of through the user's own Plex server.

   Confirmed empirically (a real Api-Key-only request against /download came back 401):
   an Api-Key alone is enough for /subtitles search, but /download requires a logged-in
   session on top of it - a JWT from /login, sent as `Authorization: Bearer <token>`
   alongside the Api-Key header. Username/password are optional Settings fields; without
   them, download() will surface whatever 401 the API returns rather than pretending it
   can work anonymously. */
import { loadFull } from "./settings.js";

const OPENSUBTITLES_API_BASE = "https://api.opensubtitles.com/api/v1";

/* OpenSubtitles' JWTs are typically valid ~24h - re-login well before that rather than
   right at expiry, and unconditionally on any 401 (see resolveDownloadLink's retry)
   since the exact lifetime isn't documented precisely enough to rely on. */
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;
let cachedToken = null;
let cachedTokenAt = 0;

/* Every throw site below calls this instead of just embedding res.status - OpenSubtitles'
   own error responses carry a reason explaining *why* (missing/invalid param, quota,
   etc), and a bare "HTTP 400" with no reason is nearly undiagnosable from the
   Settings-only info this module has access to. Two different shapes have been observed
   from the real API depending on which validation layer rejects the request: a plain
   `message` string (e.g. the Api-Key gate) and an `errors` array (e.g. request-parameter
   validation, such as "Not enough parameters") - check both rather than assuming one. */
async function readErrorMessage(res) {
    try {
        const data = await res.json();
        if (data.message) return data.message;
        if (data.error) return data.error;
        if (Array.isArray(data.errors) && data.errors.length) return data.errors.join(", ");
        return res.statusText || `HTTP ${res.status}`;
    } catch {
        return res.statusText || `HTTP ${res.status}`;
    }
}

async function getCredentials() {
    const full = await loadFull();
    return {
        apiKey: full.opensubtitles_api_key || "",
        username: full.opensubtitles_username || "",
        password: full.opensubtitles_password || "",
    };
}

async function login({ apiKey, username, password }) {
    const res = await fetch(`${OPENSUBTITLES_API_BASE}/login`, {
        method: "POST",
        headers: { "Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`OpenSubtitles login failed: ${await readErrorMessage(res)} (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.token) throw new Error("OpenSubtitles login response had no token");
    cachedToken = data.token;
    cachedTokenAt = Date.now();
    return cachedToken;
}

/* Returns null (not an error) when no username/password are configured - search still
   works without a session, so callers that only need search shouldn't be forced through
   a login attempt they have no credentials for. */
async function getAuthToken(creds) {
    if (!creds.username || !creds.password) return null;
    if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken;
    return login(creds);
}

async function authHeaders(creds) {
    if (!creds.apiKey) throw new Error("OpenSubtitles API key not configured - add one in Settings.");
    const headers = { "Api-Key": creds.apiKey, "Content-Type": "application/json", Accept: "application/json" };
    const token = await getAuthToken(creds);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

export async function search({ title, year, seasonNumber, episodeNumber, languageCode = "en" }) {
    const creds = await getCredentials();
    const headers = await authHeaders(creds);

    const url = new URL(`${OPENSUBTITLES_API_BASE}/subtitles`);
    url.searchParams.set("query", title || "");
    if (year) url.searchParams.set("year", String(year));
    if (seasonNumber != null) url.searchParams.set("season_number", String(seasonNumber));
    if (episodeNumber != null) url.searchParams.set("episode_number", String(episodeNumber));
    url.searchParams.set("languages", languageCode);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`OpenSubtitles search failed: ${await readErrorMessage(res)} (HTTP ${res.status})`);
    const data = await res.json();
    return (data.data || [])
        .map((entry) => ({
            fileId: entry.attributes?.files?.[0]?.file_id,
            label: entry.attributes?.release || entry.attributes?.feature_details?.title || title || "Subtitle",
            languageCode: entry.attributes?.language || languageCode,
        }))
        .filter((r) => r.fileId);
}

/* Split from download() below so the Android native leg can hand ExoPlayer a real HTTP
   URL directly (it fetches the .srt itself via its own HTTP data source) instead of the
   raw subtitle text getting relayed across the Capacitor bridge as a giant string.

   Retries once on a 401 with a forced fresh login - covers a cached token that expired
   mid-session without needing to track OpenSubtitles' exact JWT lifetime precisely. */
export async function resolveDownloadLink(fileId, _retriedAfterRelogin = false) {
    const creds = await getCredentials();
    const res = await fetch(`${OPENSUBTITLES_API_BASE}/download`, {
        method: "POST",
        headers: await authHeaders(creds),
        body: JSON.stringify({ file_id: fileId }),
    });
    if (res.status === 401 && !_retriedAfterRelogin && creds.username && creds.password) {
        cachedToken = null;
        return resolveDownloadLink(fileId, true);
    }
    if (!res.ok) throw new Error(`OpenSubtitles download failed: ${await readErrorMessage(res)} (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.link) throw new Error("OpenSubtitles download response had no file link");
    return data.link;
}

/* Returns the raw .srt text - only used by the web/Xbox leg, which converts to WebVTT
   itself (plex-player.js's _srtToVtt). The Android native leg uses resolveDownloadLink
   above instead and never sees this text - Media3's SubripDecoder parses .srt directly,
   so converting it here would be work done for no reason. */
export async function download(fileId) {
    const link = await resolveDownloadLink(fileId);
    const fileRes = await fetch(link);
    if (!fileRes.ok) throw new Error(`Failed fetching subtitle file: HTTP ${fileRes.status}`);
    return fileRes.text();
}
