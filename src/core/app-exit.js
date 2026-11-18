import { App } from "@capacitor/app";
import { platformTag, PLATFORM_TAG } from "../player/core/platform.js";

/* A plain browser tab can't be closed by script, so exit is only offered on wrapped builds. */
export function canExitApp() {
  return platformTag() !== PLATFORM_TAG.WEB;
}

export function exitApp() {
  if (platformTag() === PLATFORM_TAG.ANDROID) {
    App.exitApp();
    return;
  }
  window.chrome?.webview?.postMessage(JSON.stringify({ type: "exitApp" }));
}
