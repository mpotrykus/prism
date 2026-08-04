/* Plex's PIN-based sign-in flow (the OAuth-equivalent real Plex clients use) instead of
   asking the user to hand-copy their X-Plex-Token from a "View XML" link. Talks directly
   to plex.tv from the browser - verified empirically that plex.tv (unlike the local Plex
   Media Server) answers CORS preflight fine for custom headers, so no proxy is needed. */
(function () {
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

  async function requestPin() {
    const res = await fetch("https://plex.tv/api/v2/pins", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Plex-Client-Identifier": getClientId(),
        "X-Plex-Product": PRODUCT,
      },
      body: JSON.stringify({ strong: true }),
    });
    return parseJson(res, "Couldn't start Plex sign-in");
  }

  function buildAuthUrl(pin) {
    const params = new URLSearchParams({
      clientID: getClientId(),
      code: pin.code,
      "context[device][product]": PRODUCT,
    });
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  async function pollPin(pinId, { intervalMs = 1500, timeoutMs = 5 * 60 * 1000 } = {}) {
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

  async function discoverServers(authToken) {
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
    return resources
      .filter((r) => (r.provides || "").split(",").includes("server"))
      .map((r) => ({
        name: r.name,
        owned: truthy(r.owned),
        accessToken: r.accessToken || authToken,
        /* Same GUID as /identity's machineIdentifier for a given server - lets callers
           match "the server I already know about" across a re-discovery done under a
           different token (see switchHomeUser below) without re-probing connections. */
        clientIdentifier: r.clientIdentifier || "",
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

  /* Local (LAN) connections are probed before relay/remote ones - a relay hop through
     plex.tv adds real latency when the server is right there on the home network. */
  async function resolveBestConnection(server) {
    const ordered = [...server.connections].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
    for (const conn of ordered) {
      if (await probeConnection(conn.uri, server.accessToken)) return conn.uri;
    }
    return null;
  }

  /* Plex Home ("managed users"/profiles) - a family group sharing one Plex account and
     server, each with their own watch history/watchlist/parental restrictions. Listing
     and switching both work off whichever account-level token is currently active, not
     specifically the admin's - this is how Plex's own clients let you hop between
     profiles without re-entering the admin's credentials each time. */
  async function getHomeUsers(accountToken) {
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
  async function getCurrentUser(accountToken) {
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
  async function switchHomeUser(accountToken, userId, pin) {
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

  window.StreamingPlexAuth = {
    requestPin,
    buildAuthUrl,
    pollPin,
    discoverServers,
    resolveBestConnection,
    getHomeUsers,
    getCurrentUser,
    switchHomeUser,
  };
})();
