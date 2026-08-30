/* Plex's PIN-based sign-in flow (the OAuth-equivalent real Plex clients use) instead of
   asking the user to hand-copy their X-Plex-Token from a "View XML" link. Talks directly
   to plex.tv from the browser - verified empirically that plex.tv (unlike the local Plex
   Media Server) answers CORS preflight fine for custom headers, so no proxy is needed. */
const CLIENT_ID_KEY = "prism.plexClientId";
const PRODUCT = "Prism";

/* crypto.randomUUID() is only exposed in secure contexts (HTTPS or localhost) - a
   plain http://<lan-ip> origin (e.g. testing from a phone browser against the dev
   server) doesn't qualify, so fall back to building a v4 UUID from
   crypto.getRandomValues(), which has no such restriction. */
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/* Reads the body as text first rather than calling res.json() directly, so a
   non-JSON response (e.g. Plex falling back to its XML error format) surfaces which
   call and HTTP status produced it instead of an opaque "Unexpected token '<'". */
async function parseJson(res, label) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} returned non-JSON (HTTP ${res.status}, content-type: ${res.headers.get("content-type")}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${label} failed (HTTP ${res.status}): ${data.errors?.[0]?.message || data.error || text.slice(0, 200)}`);
  return data;
}

/* `strong: true` gets a long, cryptographically-strong code meant to be embedded in the
   app.plex.tv/auth URL (buildAuthUrl) for the popup-based flow. `strong: false` gets the
   short, human-typeable 4-character code plex.tv/link expects - pass that for the
   remote/gamepad "type this code on another device" flow instead. */
export async function requestPin({ strong = true } = {}) {
  const res = await fetch("https://plex.tv/api/v2/pins", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Plex-Client-Identifier": getClientId(),
      "X-Plex-Product": PRODUCT,
    },
    body: JSON.stringify({ strong }),
  });
  return parseJson(res, "Couldn't start Plex sign-in");
}

export function buildAuthUrl(pin) {
  const params = new URLSearchParams({
    clientID: getClientId(),
    code: pin.code,
    "context[device][product]": PRODUCT,
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export async function pollPin(pinId, { intervalMs = 1500, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: { Accept: "application/json", "X-Plex-Client-Identifier": getClientId() },
    });
    const data = await parseJson(res, "Couldn't check sign-in status");
    if (data.authToken) return data.authToken;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Sign-in timed out - try again.");
}

function truthy(v) {
  return v === true || v === 1 || v === "1";
}

/* /api/resources is Plex's older, XML-native "myplex" endpoint - unlike /api/v2/pins,
   it doesn't reliably honor Accept: application/json (confirmed: returns XML with a
   200 on Android's WebView even with that header set). Parse whatever content-type
   actually comes back instead of assuming JSON. */
function parseResourcesXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  return Array.from(doc.getElementsByTagName("Device")).map((device) => {
    const attrs = {};
    for (const attr of device.attributes) attrs[attr.name] = attr.value;
    const connections = Array.from(device.getElementsByTagName("Connection")).map((conn) => ({
      uri: conn.getAttribute("uri"),
      local: truthy(conn.getAttribute("local")),
    }));
    return { ...attrs, connections };
  });
}

export async function discoverServers(authToken) {
  const res = await fetch("https://plex.tv/api/resources?includeHttps=1&includeRelay=1", {
    headers: {
      Accept: "application/json",
      "X-Plex-Token": authToken,
      "X-Plex-Client-Identifier": getClientId(),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Couldn't list Plex servers (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const resources = isJson ? JSON.parse(text) : parseResourcesXml(text);
  /* Plex's own /api/resources registration for a server can go stale and report
     provides="sync" instead of "server,sync" (confirmed on a real owned server that's
     been online and working the whole time) - product is a more reliable signal since
     "Plex Media Server" is the actual PMS software's fixed product name, not a
     capability list that can drift out of sync with reality. */
  return resources
    .filter((r) => (r.provides || "").split(",").includes("server") || r.product === "Plex Media Server")
    .map((r) => ({
      name: r.name,
      owned: truthy(r.owned),
      accessToken: r.accessToken || authToken,
      /* Same GUID as /identity's machineIdentifier for a given server - lets callers
         match "the server I already know about" across a re-discovery done under a
         different token (see switchHomeUser below) without re-probing connections. */
      clientIdentifier: r.clientIdentifier || "",
      /* Only present on a shared (owned:false) server - names the friend's account that
         shared it, straight from Plex's own /api/resources response. Used to label
         multi-server library tabs by owner (settings.js/nav.js). */
      sourceTitle: r.sourceTitle || "",
      connections: (r.connections || []).map((c) => ({ uri: c.uri, local: truthy(c.local) })),
    }));
}

async function probeConnection(uri, token, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const u = new URL(uri + "/identity");
    u.searchParams.set("X-Plex-Token", token);
    const res = await fetch(u, { headers: { Accept: "application/json" }, signal: controller.signal });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function raceFirstReachable(conns, token) {
  try {
    return await Promise.any(
      conns.map(async (c) => {
        if (await probeConnection(c.uri, token)) return c.uri;
        throw new Error("unreachable");
      })
    );
  } catch {
    return null;
  }
}

/* Local (LAN) connections are raced against each other before relay/remote ones are
   even tried - a relay hop through plex.tv adds real latency when the server is right
   there on the home network. Within a group, all connections are probed concurrently
   (Promise.any) rather than one at a time, so one dead LAN candidate's 2.5s timeout
   doesn't block trying the next candidate. */
export async function resolveBestConnection(server) {
  const local = server.connections.filter((c) => c.local);
  const remote = server.connections.filter((c) => !c.local);
  for (const group of [local, remote]) {
    if (!group.length) continue;
    const uri = await raceFirstReachable(group, server.accessToken);
    if (uri) return uri;
  }
  return null;
}

const SECTION_TYPE_MAP = { movie: 1, show: 2 };

async function plexGetJson(url, token, path) {
  const u = new URL(url + path);
  u.searchParams.set("X-Plex-Token", token);
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* Discovers every server on the signed-in account - owned plus anything a friend has
   shared - and every movie/show library on each, defaulting everything to enabled.
   Shared by the sign-in flow (plex-signin.js - a fresh sign-in should land with
   everything already browsable, not require a manual trip to Settings) and Settings'
   own "refresh servers" flow, which passes prevServers/prevSections so a re-discovery
   preserves whatever enabled/label/all_enabled toggles the user already set instead of
   resetting them every time. */
export async function discoverLibraries(accountToken, { prevServers = [], prevSections = [] } = {}) {
  const discovered = await discoverServers(accountToken);
  const prevServersById = new Map(prevServers.map((s) => [s.id, s]));
  const prevSectionsByServerKey = new Map(prevSections.map((s) => [`${s.server_id}:${s.key}`, s]));

  /* Each server's connection probing + section listing is independent of every other
     server's, so they're run concurrently (Promise.all) instead of one server at a
     time - a multi-server account no longer pays each server's probe/fetch latency
     serially. Promise.all preserves `discovered`'s order in `results`, so the merge
     below still produces servers/sections in the same order the old sequential loop
     did. */
  const results = await Promise.all(
    discovered.map(async (d) => {
      const id = d.clientIdentifier;
      if (!id) return null;
      const prevServer = prevServersById.get(id);
      const uri = await resolveBestConnection(d);
      if (!uri) {
        /* Keep whatever was already saved for it rather than dropping it - a friend's
           server being briefly offline shouldn't wipe out every toggle the user set
           for it, and data.js's own fetches already tolerate a stale/unreachable
           server gracefully (empty results, not a hard error). */
        return {
          unreachable: true,
          servers: prevServer ? [prevServer] : [],
          sections: prevServer ? prevSections.filter((s) => s.server_id === id) : [],
        };
      }
      const server = {
        id,
        name: d.name,
        owned: d.owned,
        sourceTitle: d.sourceTitle || "",
        url: uri,
        token: d.accessToken,
        /* Defaults to fully on for a newly-discovered server (confirmed with the user:
           a friend sharing a library should show up right away, not require an opt-in
           per library first). */
        all_enabled: prevServer ? prevServer.all_enabled !== false : true,
        /* Unlike all_enabled above, a newly-discovered server defaults to NOT having its own
           "All libraries on this server" tab - same show_tab convention as an individual
           library (see below) - so a multi-server account starts collapsed to just Home/
           Movies/TV Shows instead of one tab per server on top of those three. */
        show_tab: prevServer ? prevServer.show_tab === true : false,
      };
      const sections = [];
      try {
        const data = await plexGetJson(uri, d.accessToken, "/library/sections");
        const dirs = data?.MediaContainer?.Directory || [];
        for (const dir of dirs) {
          if (!SECTION_TYPE_MAP[dir.type]) continue;
          const prev = prevSectionsByServerKey.get(`${id}:${dir.key}`);
          sections.push({
            key: Number(dir.key),
            type: SECTION_TYPE_MAP[dir.type],
            label: prev?.label || dir.title,
            enabled: prev ? prev.enabled !== false : true,
            /* Unlike `enabled` above, a newly-discovered library defaults to NOT having its
               own tab - it still feeds Home/Movies/TV Shows once enabled, but doesn't clutter
               the nav with a tab per library until the user opts in (confirmed with the
               user). */
            show_tab: prev ? prev.show_tab === true : false,
            server_id: id,
          });
        }
      } catch (e) {
        // couldn't list this server's libraries this pass - keep whatever was already saved for it
        sections.push(...prevSections.filter((s) => s.server_id === id));
      }
      return { unreachable: false, servers: [server], sections };
    })
  );

  const servers = [];
  const sections = [];
  let unreachableCount = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.unreachable) unreachableCount++;
    servers.push(...r.servers);
    sections.push(...r.sections);
  }
  return { servers, sections, unreachableCount };
}

/* Called before every data load - the connection resolveBestConnection() picks at
   sign-in time (LAN-first) is cached as a single plex_url and never re-checked, so
   leaving the home network doesn't fail, it just hangs every fetch against an address
   that's no longer reachable (a private LAN IP gives no fast refusal from outside the
   LAN). Re-probes that cached address first and, only if it's gone dark, re-runs
   discovery to find whichever connection - relay or remote - actually works from here. */
export async function ensureReachable({ plex_url, plex_token, plex_account_token, machine_id }) {
  if (await probeConnection(plex_url, plex_token)) return { plex_url, plex_token };
  if (!plex_account_token || !machine_id) {
    throw new Error(`Can't reach your Plex server at ${plex_url}.`);
  }
  const servers = await discoverServers(plex_account_token);
  const server = servers.find((s) => s.clientIdentifier === machine_id);
  if (!server) throw new Error("Can't reach your Plex server, and it's no longer listed on this account.");
  const uri = await resolveBestConnection(server);
  if (!uri) throw new Error(`Can't reach ${server.name} from this network.`);
  return { plex_url: uri, plex_token: server.accessToken };
}

/* Plex Home ("managed users"/profiles) - a family group sharing one Plex account and
   server, each with their own watch history/watchlist/parental restrictions. Listing
   and switching both work off whichever account-level token is currently active, not
   specifically the admin's - this is how Plex's own clients let you hop between
   profiles without re-entering the admin's credentials each time. */
export async function getHomeUsers(accountToken) {
  const res = await fetch("https://plex.tv/api/v2/home/users", {
    headers: { Accept: "application/json", "X-Plex-Token": accountToken, "X-Plex-Client-Identifier": getClientId() },
  });
  const data = await parseJson(res, "Couldn't list Plex Home profiles");
  return (data.users || data.Users || []).map((u) => ({
    id: u.id,
    uuid: u.uuid || "",
    title: u.title || u.friendlyName || u.username || "Profile",
    thumb: u.thumb || "",
    admin: truthy(u.admin),
    guest: truthy(u.guest),
    restricted: truthy(u.restricted),
    protected: truthy(u.protected),
  }));
}

/* Identifies whichever profile the given token currently is, so the switcher UI can
   mark one of the getHomeUsers() entries as "this one, right now". */
export async function getCurrentUser(accountToken) {
  const res = await fetch("https://plex.tv/api/v2/user", {
    headers: { Accept: "application/json", "X-Plex-Token": accountToken, "X-Plex-Client-Identifier": getClientId() },
  });
  const data = await parseJson(res, "Couldn't look up the current Plex profile");
  return { id: data.id, uuid: data.uuid || "" };
}

/* Exchanges the current account token for one scoped to a different Home profile -
   mirrors requestPin/pollPin's role in the sign-in flow, just skipping the PIN/pairing
   round-trip since the account is already authenticated. The returned token is then
   used exactly like a fresh sign-in's authToken: re-run discoverServers() with it to
   get that profile's own per-server access token (each profile gets a distinct one
   even though they share the same physical server - that's what makes per-profile
   history/watchlist/restrictions possible).
   Confirmed empirically: unlike getHomeUsers/getCurrentUser above, this action lives
   on the older non-"v2" endpoint - /api/v2/home/users/<id>/switch 404s, only
   /api/home/users/<id>/switch works. Like /api/resources elsewhere in this file, it's
   an old myplex endpoint that doesn't reliably honor Accept: application/json, so the
   response is parsed as whichever content-type actually comes back rather than
   assumed JSON. */
export async function switchHomeUser(accountToken, userId, pin) {
  const qs = pin ? `?${new URLSearchParams({ pin })}` : "";
  const res = await fetch(`https://plex.tv/api/home/users/${userId}/switch${qs}`, {
    method: "POST",
    headers: { Accept: "application/json", "X-Plex-Token": accountToken, "X-Plex-Client-Identifier": getClientId() },
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") || "").includes("json");
  let authToken = null;
  let errorMessage = null;
  if (isJson) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
    authToken = data?.authToken || data?.authenticationToken || null;
    errorMessage = data?.errors?.[0]?.message || data?.error || null;
  } else {
    /* This endpoint's XML error shape is <Response code="401" status="Invalid PIN"/> -
       "status" here is Plex's message text, not an HTTP status. */
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const root = doc.documentElement;
    authToken = root?.getAttribute("authToken") || root?.getAttribute("authenticationToken") || null;
    errorMessage = root?.getAttribute("status") || null;
  }
  if (!res.ok) throw new Error(errorMessage || `Couldn't switch Plex profile (HTTP ${res.status})`);
  if (!authToken) throw new Error("Plex didn't return a token for that profile.");
  return authToken;
}
