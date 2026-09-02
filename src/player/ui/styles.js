import BASE_CSS from "../styles/base.css?inline";
import CONTROLS_CSS from "../styles/controls.css?inline";
import TRANSPORT_CSS from "../styles/transport.css?inline";
import MENU_CSS from "../styles/menu.css?inline";
import SUBTITLES_CSS from "../styles/subtitles.css?inline";
import LIST_CSS from "../styles/list.css?inline";
import MODAL_CSS from "../styles/modal.css?inline";

/* The player chrome's stylesheet, injected once into document.head.

   It can't live in a shadow root the way src/card/styles/ does: on Xbox the chrome renders
   over a native video surface that sits behind a transparent WebView2, so everything here is
   appended to document.body. Every class is `prism-player-` prefixed to keep that global
   footprint identifiable.

   Injected lazily rather than at module load - nothing needs it until playback actually
   starts, and the module is imported far earlier than that. */
const STYLE_ID = "prism-player-styles";

export function ensurePlayerStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [BASE_CSS, CONTROLS_CSS, TRANSPORT_CSS, MENU_CSS, SUBTITLES_CSS, LIST_CSS, MODAL_CSS].join("\n");
    document.head.appendChild(style);
}
