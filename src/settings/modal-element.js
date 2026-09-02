import { reflectControllerActive } from "../core/focus-nav.js";
import MODAL_SHELL_STYLE from "../styles/modal-shell.css?inline";

/* What the Settings and Plex sign-in modals have in common: a shadow root carrying the
   shared shell stylesheet plus their own, an .overlay/.modal structure that closes on a
   backdrop click or the "✕", and the controller-active reflection their :host([...]) rules
   key off. Everything else - what the modal contains, when it may be closed, what happens on
   open - belongs to each subclass. */
export class PrismModalElement extends HTMLElement {
    /* Called from connectedCallback with the subclass's own stylesheet and body markup. */
    _buildShell(ownStyle, bodyHtml) {
        reflectControllerActive(this);
        this.attachShadow({ mode: "open" });
        this.shadowRoot.innerHTML = `<style>${MODAL_SHELL_STYLE}${ownStyle}</style>${bodyHtml}`;
        this._overlay = this._el(".overlay");
        this._el(".modal-close").addEventListener("click", () => this.close());
        this._overlay.addEventListener("click", (e) => {
            if (e.target === this._overlay) this.close();
        });
    }

    _el(sel) {
        return this.shadowRoot.querySelector(sel);
    }

    close() {
        this._overlay.classList.remove("open");
    }

    isOpen() {
        return this._overlay.classList.contains("open");
    }
}
