/* Plex Home profile switching. Listing/current-profile lookup and the actual switch
   action mix two different Plex API generations - see plex-auth.js's own comments for
   why (the switch endpoint isn't the "v2" one getHomeUsers/getCurrentUser use). */
import * as StreamingPlexAuth from "../../plex-auth.js";
import * as StreamingVault from "../../vault.js";

export const PROFILE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/* Only worth surfacing the switcher UI at all when there's more than one profile (a
   solo account has nothing to switch to). Failures (no account token yet, no Plex Home
   set up, network error) all collapse to "no switcher", same as an empty list - none of
   them should ever block the rest of the dashboard from loading. */
export async function fetchHomeProfiles(accountToken) {
  if (!accountToken) return { users: [], activeId: null };
  try {
    const [users, current] = await Promise.all([
      StreamingPlexAuth.getHomeUsers(accountToken),
      StreamingPlexAuth.getCurrentUser(accountToken),
    ]);
    const active = users.find((u) => u.uuid && u.uuid === current.uuid) || users.find((u) => u.id === current.id);
    return { users, activeId: active ? active.id : null };
  } catch (e) {
    return { users: [], activeId: null };
  }
}

export function renderProfileNav(profileNavItem, profileNavLabel, profileNavIcon, users, activeUserId, escape) {
  const showSwitcher = users.length > 1;
  profileNavItem.hidden = !showSwitcher;
  if (!showSwitcher) return;
  const active = users.find((u) => u.id === activeUserId);
  profileNavLabel.textContent = active ? active.title : "Profile";
  profileNavIcon.innerHTML = active?.thumb ? `<span class="nav-profile-avatar"><img src="${escape(active.thumb)}" alt="" /></span>` : PROFILE_ICON_SVG;
}

/* onSwitch(user, rowEl) is called when a non-active row's Switch button is clicked -
   the card owns the actual switch action (see switchToUser below) since it needs to
   mutate config/reload data on success. */
export function renderProfileList(profileListEl, users, activeUserId, escape, onSwitch) {
  profileListEl.innerHTML = users
    .map((u) => {
      const isActive = u.id === activeUserId;
      const avatar = u.thumb ? `<img src="${escape(u.thumb)}" alt="" />` : PROFILE_ICON_SVG;
      return `
      <div class="profile-row${isActive ? " active" : ""}" data-id="${u.id}">
        <div class="profile-avatar">${avatar}</div>
        <div class="profile-name">${escape(u.title)}</div>
        <button type="button" class="profile-switch-btn" ${isActive ? "disabled" : ""}>${isActive ? "Current" : "Switch"}</button>
        <div class="profile-row-status"></div>
      </div>`;
    })
    .join("");
  profileListEl.querySelectorAll(".profile-row").forEach((rowEl) => {
    if (rowEl.classList.contains("active")) return;
    const user = users.find((u) => u.id === Number(rowEl.dataset.id));
    rowEl.querySelector(".profile-switch-btn").addEventListener("click", () => onSwitch(user, rowEl));
  });
}

/* Protected profiles get prompted through the shared numeric-keypad PIN modal (see
   src/card/pin.js) instead of a plain text input. A wrong entry here isn't retried
   automatically: only Plex can say whether it was right, so a rejected PIN just reports
   the error and leaves the user to press "Switch" again. onSuccess({ plexToken,
   accountToken, userId }) lets the card
   apply the new tokens/active-profile state and reload data - kept as an explicit
   callback rather than this module reaching into card state directly. */
export async function switchToUser(user, rowEl, { promptForDigits, accountToken, machineId, onSuccess }) {
  let pin;
  if (user.protected) {
    pin = await promptForDigits(4, `Enter PIN for ${user.title}`);
    if (pin === null) return;
  }
  rowEl.classList.add("busy");
  const statusEl = rowEl.querySelector(".profile-row-status");
  statusEl.textContent = "";
  try {
    const newAccountToken = await StreamingPlexAuth.switchHomeUser(accountToken, user.id, pin);
    const servers = await StreamingPlexAuth.discoverServers(newAccountToken);
    const server = servers.find((s) => s.clientIdentifier && s.clientIdentifier === machineId) || servers[0];
    if (!server) throw new Error("This profile can't reach the connected Plex server.");
    const existingSecrets = StreamingVault.hasSecrets() ? await StreamingVault.loadSecrets() : {};
    const secrets = { ...existingSecrets, plex_token: server.accessToken, plex_account_token: newAccountToken };
    await StreamingVault.saveSecrets(secrets);
    await onSuccess({ plexToken: server.accessToken, accountToken: newAccountToken, userId: user.id });
  } catch (e) {
    rowEl.classList.remove("busy");
    statusEl.textContent = e.message;
  }
}
