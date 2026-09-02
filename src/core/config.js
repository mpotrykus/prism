import { hasSecrets, loadSecrets } from "./vault.js";
import DEFAULT_PLAIN_CONFIG from "./app-settings.defaults.json";

/* The app's config store, split out from the Settings modal that edits it: the card's data
   layer and the subtitle providers only ever read config, and importing them through the
   modal dragged its whole shadow-DOM template and stylesheet along for the ride.

   Only non-sensitive fields live here in plain localStorage. plex_token,
   openrouter_api_key and plex_account_token go through vault.js instead (encrypted at
   rest). plex_account_token is the plex.tv account token from the Sign in with Plex flow,
   kept separately from plex_token (the per-server access token) so "refresh servers" can
   re-run discovery later without a full re-login. */
const PLAIN_STORAGE_KEY = "prism.config";

export function loadPlain() {
    try {
        const raw = JSON.parse(localStorage.getItem(PLAIN_STORAGE_KEY) || "null") || {};
        return { ...DEFAULT_PLAIN_CONFIG, ...raw };
    } catch (e) {
        return { ...DEFAULT_PLAIN_CONFIG };
    }
}

export function savePlain(config) {
    localStorage.setItem(PLAIN_STORAGE_KEY, JSON.stringify(config));
}

/* Per-server access tokens are secrets (server_tokens, keyed by clientIdentifier) but the
   servers they belong to are plain metadata (name/url/owned/...), so they're merged back
   onto each server here rather than through the flat {...plain, ...secrets} spread - which
   would otherwise let a `servers` key on `secrets` blow away plain's server list instead of
   extending it. */
export function mergeServerTokens(plainServers, secrets) {
    return (plainServers || []).map((s) => ({ ...s, token: secrets.server_tokens?.[s.id] || "" }));
}

/* Full config = plain fields + decrypted secrets - what the card's setConfig()/
   refreshConfig() expects. */
export async function loadFull() {
    const plain = loadPlain();
    const secrets = hasSecrets() ? await loadSecrets() : {};
    return { ...plain, ...secrets, servers: mergeServerTokens(plain.servers, secrets) };
}

export function isConfigured(fullConfig) {
    return !!(fullConfig && fullConfig.plex_url && fullConfig.plex_token);
}
