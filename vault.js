/* Secrets (plex_token, youtube_api_key, openrouter_api_key, plex_account_token) are
   encrypted at rest with a non-extractable AES key stored in IndexedDB, instead of
   plaintext localStorage - but deliberately without any WebAuthn/biometric gate.
   plex_token now comes from Plex's own PIN-based sign-in (plex-signin.js) rather than
   being hand-typed, so there's no local secret-entry step left that justifies prompting
   Windows Hello/Android biometrics on every save and load. */
const META_KEY = "prism.vaultMeta";
const SECRETS_KEY = "prism.secrets";
const DB_NAME = "prismVault";
const DB_STORE = "keys";
const KEY_RECORD_ID = "vaultKey";

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(id, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getOrCreateIdbKey() {
  let key = await idbGet(KEY_RECORD_ID);
  if (!key) {
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbSet(KEY_RECORD_ID, key);
  }
  return key;
}

/* Secrets saved under the old WebAuthn-gated tiers ("prf"/"gate") were encrypted
   with a key this code can no longer derive - that required a live biometric/PIN
   assertion this vault no longer performs. Drop them rather than leave an
   undecryptable blob sitting in storage forever; the user just signs into Plex again
   (plex-signin.js) and re-enters any optional API keys. Only actually does anything
   once, on the first load after this change ships to a given device/browser. */
(function migrateAwayFromWebAuthnTiers() {
  let meta;
  try {
    meta = JSON.parse(localStorage.getItem(META_KEY) || "null");
  } catch (e) {
    meta = null;
  }
  if (meta && meta.mode !== "plain") {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(SECRETS_KEY);
  }
})();

export function hasSecrets() {
  return !!localStorage.getItem(SECRETS_KEY);
}

export async function saveSecrets(obj) {
  const key = await getOrCreateIdbKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  localStorage.setItem(SECRETS_KEY, JSON.stringify({ iv: bufToB64(iv), data: bufToB64(cipher) }));
}

export async function loadSecrets() {
  const raw = localStorage.getItem(SECRETS_KEY);
  if (!raw) return {};
  const blob = JSON.parse(raw);
  const key = await getOrCreateIdbKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBuf(blob.iv) }, key, b64ToBuf(blob.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export function status() {
  return hasSecrets() ? "plain" : "none";
}
