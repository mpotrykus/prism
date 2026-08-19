import { DEBAND_TUNING } from "./shaders.js";
import { renderShaderOnce } from "../shader-pipeline.js";

/* TEMPORARY dev tool for live-tuning Deband's threshold/range/grain against real playback
   instead of edit-file-and-reload. DEBAND_TUNING's properties are read fresh every frame by
   shader-pipeline.js's renderShaderFrame (they're just uniforms, not compile-time constants),
   so mutating them here takes effect on the very next frame with no chain rebuild needed.
   Delete this file and its two call sites in player-chrome.js once the real defaults are
   settled. */

const FIELDS = [
    { key: "threshold", label: "Threshold", min: 0, max: 20, step: 0.5 },
    { key: "range", label: "Range", min: 0, max: 48, step: 1 },
    { key: "grain", label: "Grain", min: 0, max: 20, step: 0.5 },
];

export function mountDebandTuningPanel(controller) {
    if (controller._debandTuningPanelEl) return;
    const el = document.createElement("div");
    el.className = "streaming-player-deband-tuning-panel";
    Object.assign(el.style, {
        position: "fixed",
        top: "90px",
        right: "24px",
        zIndex: "10001",
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        font: "11px/1.4 'SFMono-Regular', Consolas, monospace",
        padding: "10px 12px",
        borderRadius: "6px",
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        minWidth: "180px",
    });

    const title = document.createElement("div");
    title.textContent = "Deband tuning (temp)";
    title.style.opacity = "0.7";
    title.style.marginBottom = "2px";
    el.appendChild(title);

    for (const field of FIELDS) {
        const row = document.createElement("label");
        Object.assign(row.style, { display: "flex", flexDirection: "column", gap: "2px" });

        const text = document.createElement("span");
        text.textContent = `${field.label}: ${DEBAND_TUNING[field.key]}`;

        const input = document.createElement("input");
        input.type = "range";
        input.min = field.min;
        input.max = field.max;
        input.step = field.step;
        input.value = DEBAND_TUNING[field.key];
        input.addEventListener("input", () => {
            const value = parseFloat(input.value);
            DEBAND_TUNING[field.key] = value;
            text.textContent = `${field.label}: ${value}`;
            /* Frame-driven loops (rVFC/rAF) already pick this up on the next decoded frame
               during playback - this only matters while paused, same reasoning as any other
               settings change in shader-pipeline.js. */
            renderShaderOnce(controller);
        });

        row.appendChild(text);
        row.appendChild(input);
        el.appendChild(row);
    }

    document.body.appendChild(el);
    controller._debandTuningPanelEl = el;
}

export function unmountDebandTuningPanel(controller) {
    if (controller._debandTuningPanelEl) {
        controller._debandTuningPanelEl.remove();
        controller._debandTuningPanelEl = null;
    }
}
