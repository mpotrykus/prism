import { SOURCE } from "./pass-chain.js";

/* Loader for mpv's user-shader format (the `//!HOOK`/`//!BIND`/`//!SAVE` files that
   Anime4K, ArtCNN, FSR, NVScaler and mpv's own deband all ship as), turning one into the
   pass descriptors shader/pass-chain.js executes.

   Why a loader instead of hand-porting each algorithm: these shaders are the actual
   published implementations, weights and all - Anime4K's CNN is ~900 trained parameters
   baked into mat4 literals, which is not something a port can approximate. Consuming the
   upstream file verbatim means the vendored copy is diffable against upstream, a version
   bump is a re-download rather than a re-port, and there's no opportunity for a
   transcription error in a weight matrix to quietly degrade output. It also means the same
   vendored .glsl feeds Android's leg unchanged.

   Supported subset: HOOK, BIND, SAVE, WIDTH, HEIGHT, COMPONENTS, DESC, WHEN. Deliberately
   NOT supported: COMPUTE (WebGL2 has no compute shaders at all - this is what rules out
   NVScaler's and ArtCNN's mpv ports here, not a gap in this loader) and TEXTURE/FORMAT/
   FILTER (loader-provided LUT textures, only used by the compute-based shaders anyway).
   Anything unsupported throws at load time so the preset is dropped rather than silently
   rendering wrong. */

/* mpv writes size expressions in reverse Polish notation, e.g.
     //!WIDTH conv2d_last_tf.w 2 *
     //!WHEN OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *
   Comparisons push 1.0/0.0 so they compose with `*` as a logical AND, which is how mpv's
   own multi-condition WHEN clauses are written. */
const BINARY_OPS = {
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    ">": (a, b) => (a > b ? 1 : 0),
    "<": (a, b) => (a < b ? 1 : 0),
    "=": (a, b) => (a === b ? 1 : 0),
};

export function evalRpn(expr, lookup) {
    const stack = [];
    for (const token of expr.trim().split(/\s+/)) {
        if (!token) continue;
        if (token === "!") {
            const a = stack.pop();
            stack.push(a ? 0 : 1);
            continue;
        }
        const op = BINARY_OPS[token];
        if (op) {
            const b = stack.pop();
            const a = stack.pop();
            if (a === undefined || b === undefined) throw new Error(`RPN underflow in "${expr}"`);
            stack.push(op(a, b));
            continue;
        }
        const numeric = Number(token);
        if (Number.isFinite(numeric)) {
            stack.push(numeric);
            continue;
        }
        const swizzled = /^(.+)\.(w|h)$/.exec(token);
        if (!swizzled) throw new Error(`unsupported RPN token "${token}" in "${expr}"`);
        const [w, h] = lookup(swizzled[1]);
        stack.push(swizzled[2] === "w" ? w : h);
    }
    if (stack.length !== 1) throw new Error(`RPN "${expr}" left ${stack.length} values on the stack`);
    return stack[0];
}

/* Splits the file on directive blocks. Everything before the first directive (the upstream
   license header) is not part of any pass and is dropped from what gets compiled - the
   vendored file keeps it, which is the copy that matters for attribution. */
function splitPasses(source) {
    const lines = source.split(/\r?\n/);
    const passes = [];
    let current = null;
    let inDirectiveBlock = false;

    for (const line of lines) {
        const directive = /^\/\/!\s*([A-Z_]+)\s*(.*)$/.exec(line);
        if (directive) {
            if (!inDirectiveBlock) {
                current = { directives: [], body: [] };
                passes.push(current);
                inDirectiveBlock = true;
            }
            current.directives.push({ key: directive[1], value: directive[2].trim() });
            continue;
        }
        inDirectiveBlock = false;
        if (current) current.body.push(line);
    }
    return passes;
}

function directiveValue(directives, key) {
    const found = directives.find((d) => d.key === key);
    return found ? found.value : null;
}

/* mpv's per-binding macro surface. `X_pos` is vUv for every binding because every texture
   in this pipeline covers the same rectangle - only the resolution differs - so a
   normalized coordinate is already in every binding's own space. That is not true in mpv
   itself (chroma planes can be offset/subsampled), which is why this loader only accepts
   shaders whose hook target is the full-resolution image. */
function bindingMacros(name) {
    return [
        `uniform sampler2D ${name};`,
        `uniform vec2 ${name}Size;`,
        `#define ${name}_tex(p) texture(${name}, p)`,
        `#define ${name}_texOff(o) texture(${name}, vUv + (o) * (1.0 / ${name}Size))`,
        `#define ${name}_pos vUv`,
        `#define ${name}_size ${name}Size`,
        `#define ${name}_pt (1.0 / ${name}Size)`,
        `#define ${name}_mul 1.0`,
        `#define ${name}_raw ${name}_tex`,
    ].join("\n");
}

const PREAMBLE = `#version 300 es
/* highp is not optional: these shaders carry signed CNN activations well outside 0..1, and
   mediump on a mobile GPU quantizes them into visible blocking. */
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 prismFragColor;
`;

const EPILOGUE = `
void main() { prismFragColor = hook(); }
`;

/* Returns { passes, when } where `passes` is ready for createPassChain and `when` is the
   chain-level gate (null if the file has none).

   The gate is chain-level rather than per-pass because skipping an individual pass mid-chain
   changes what every later BIND resolves to, which this runtime has no way to express. That is
   fine for the files it consumes: a pass carrying no WHEN of its own still depends, through its
   BINDs, on one that does. FSR 1 is the concrete case - its EASU pass is gated on "is the
   output bigger than the source" and SAVEs EASUTEX, while its RCAS pass carries no clause and
   binds EASUTEX. In mpv, skipping EASU means EASUTEX never exists and RCAS is skipped with it,
   so hoisting EASU's clause to the whole file reproduces mpv's behavior exactly.

   Two genuinely *different* clauses in one file is still rejected: that would need real
   per-pass gating to honour. Over-gating is the safe direction anyway - a gated-off chain falls
   back to the family's single-pass sharpen, which still renders a correct picture. */
export function loadMpvUserShader(source, { name = "user-shader", inputSymbol = SOURCE } = {}) {
    const raw = splitPasses(source);
    if (!raw.length) throw new Error(`${name}: no //! directives found`);

    /* mpv name -> pass id holding its current contents. A pass that SAVEs an existing name
       (Anime4K's chains end by saving back over MAIN) rebinds it for every later pass,
       which is why this is resolved here rather than left for the runtime. `inputSymbol` is
       what the image already is on entry - SOURCE for a standalone file, the previous
       file's last pass when several are concatenated (see loadMpvUserShaderChain). It has
       to be threaded in here rather than patched onto the result afterwards, because the
       WIDTH/HEIGHT expressions resolve names through this same table. */
    const symbols = new Map([
        ["MAIN", inputSymbol],
        ["LUMA", inputSymbol],
        ["NATIVE", inputSymbol],
        ["HOOKED", inputSymbol],
    ]);
    const passes = [];
    let when = null;

    raw.forEach((entry, index) => {
        const { directives, body } = entry;
        const desc = directiveValue(directives, "DESC") || `${name} pass ${index}`;

        for (const { key } of directives) {
            if (key === "COMPUTE") throw new Error(`${desc}: COMPUTE passes need compute shaders, unavailable in WebGL2`);
            if (key === "TEXTURE" || key === "FORMAT" || key === "FILTER" || key === "SIZE") {
                throw new Error(`${desc}: loader-supplied ${key} textures are not supported`);
            }
        }

        const hook = directiveValue(directives, "HOOK");
        if (!hook) throw new Error(`${desc}: missing //!HOOK`);
        if (!symbols.has(hook)) throw new Error(`${desc}: unsupported hook target "${hook}"`);

        const passWhen = directiveValue(directives, "WHEN");
        if (passWhen) {
            if (when === null) when = passWhen;
            else if (when !== passWhen) throw new Error(`${desc}: two different //!WHEN clauses in one file`);
        }

        const binds = directives.filter((d) => d.key === "BIND").map((d) => d.value);
        if (!binds.length) throw new Error(`${desc}: no //!BIND`);
        const id = `${name}#${index}`;

        const inputs = binds.map((bind) => {
            /* HOOKED is mpv's alias for whatever the hook target currently holds. */
            const target = bind === "HOOKED" ? hook : bind;
            if (!symbols.has(target)) throw new Error(`${desc}: BIND "${bind}" before anything SAVEd it`);
            return { uniform: bind, from: symbols.get(target) };
        });

        const widthExpr = directiveValue(directives, "WIDTH");
        const heightExpr = directiveValue(directives, "HEIGHT");
        /* Snapshot, not the live `symbols` map. The size closure below runs at render time,
           long after every later pass's SAVE has mutated that map - so resolving through it
           lazily made pass 0's `MAIN.w` mean "whatever saved MAIN last", i.e. a pass further
           down the chain that isn't allocated yet. mpv's WIDTH/HEIGHT expressions name
           bindings as they exist *at that pass*, which is what this captures. Caught by the
           GL harness on the first real run of the Anime4K chain: "pass size references
           a4k-restore#3 before it is allocated". */
        const symbolsHere = new Map(symbols);

        passes.push({
            name: id,
            desc,
            frag: [PREAMBLE, ...binds.map(bindingMacros), body.join("\n"), EPILOGUE].join("\n"),
            inputs,
            /* Signed activations again - an RGBA8 target would clamp them to 0, which is a
               wrong image rather than a cheaper one, so this is required not preferred. */
            float: "required",
            size: (ctx) => {
                const lookup = (symbol) => {
                    if (symbol === "OUTPUT") return [ctx.outW, ctx.outH];
                    const resolved = symbolsHere.has(symbol) ? symbolsHere.get(symbol) : symbol;
                    return ctx.sizeOf(resolved);
                };
                const w = widthExpr ? evalRpn(widthExpr, lookup) : null;
                const h = heightExpr ? evalRpn(heightExpr, lookup) : null;
                const [inW, inH] = ctx.sizeOf(inputs[0].from);
                return [Math.round(w ?? inW), Math.round(h ?? inH)];
            },
        });

        /* SAVE defaults to the hook target, matching mpv - a pass with no //!SAVE is the
           chain's output for that hook. */
        const save = directiveValue(directives, "SAVE") || hook;
        symbols.set(save, id);
    });

    return {
        passes,
        /* Evaluated per frame by the caller against the live geometry, before any render
           target exists - so every symbol other than OUTPUT resolves to the source size
           rather than to an intermediate pass. That is exactly what these clauses mean:
           Anime4K's is "only run if the display is at least 1.2x the video in both axes",
           i.e. the "don't pay for an upscaler that isn't upscaling" gate this pipeline
           wants anyway. */
        when: when ? (ctx) => evalRpn(when, (symbol) => (symbol === "OUTPUT" ? [ctx.outW, ctx.outH] : [ctx.sourceW, ctx.sourceH])) !== 0 : null,
    };
}

/* Concatenates several user-shader files into one chain, the way mpv's
   `glsl-shaders=a.glsl:b.glsl` does - Anime4K's documented presets are exactly this (a
   Restore file followed by an Upscale file). Later files see the earlier ones' MAIN. */
export function loadMpvUserShaderChain(sources, inputSymbol = SOURCE) {
    const passes = [];
    const gates = [];
    /* `inputSymbol` is what the first file's MAIN starts at - SOURCE normally, or an optional
       preceding pass (deband) when one is composed in front. See shaders.js's composePasses. */
    let sourceSymbol = inputSymbol;

    sources.forEach(({ source, name }) => {
        const loaded = loadMpvUserShader(source, { name, inputSymbol: sourceSymbol });
        passes.push(...loaded.passes);
        if (loaded.when) gates.push(loaded.when);
        sourceSymbol = loaded.passes[loaded.passes.length - 1].name;
    });

    return {
        passes,
        when: gates.length ? (ctx) => gates.every((gate) => gate(ctx)) : null,
    };
}
