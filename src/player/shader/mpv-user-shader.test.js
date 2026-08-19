import { describe, it, expect } from "vitest";
import { evalRpn, loadMpvUserShader, loadMpvUserShaderChain } from "./mpv-user-shader.js";
import { SOURCE } from "./pass-chain.js";
import { SHADER_TYPES } from "./shaders.js";

const sizes = { MAIN: [1920, 1080], OUTPUT: [3840, 2160], conv2d_tf: [1920, 1080] };
const lookup = (name) => sizes[name];

describe("evalRpn", () => {
  it("evaluates a plain multiply", () => {
    expect(evalRpn("conv2d_tf.w 2 *", lookup)).toBe(3840);
  });

  it("evaluates comparisons as 1/0 so * acts as logical AND", () => {
    expect(evalRpn("OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *", lookup)).toBe(1);
  });

  it("returns 0 when only one side of an ANDed condition holds", () => {
    const narrow = (name) => (name === "OUTPUT" ? [3840, 1080] : sizes[name]);
    expect(evalRpn("OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *", narrow)).toBe(0);
  });

  it("rejects an unknown token rather than silently yielding a wrong size", () => {
    expect(() => evalRpn("MAIN.z 2 *", lookup)).toThrow(/unsupported RPN token/);
  });

  it("rejects an expression that leaves a dangling operand", () => {
    expect(() => evalRpn("MAIN.w MAIN.h", lookup)).toThrow(/left 2 values/);
  });
});

const TWO_PASS = `// license header, not part of any pass
//!DESC first
//!HOOK MAIN
//!BIND MAIN
//!SAVE feature
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
vec4 hook() { return MAIN_texOff(vec2(0.0, 0.0)); }
//!DESC second
//!HOOK MAIN
//!BIND MAIN
//!BIND feature
//!SAVE MAIN
//!WIDTH feature.w 2 *
//!HEIGHT feature.h 2 *
vec4 hook() { return MAIN_tex(MAIN_pos) + feature_tex(feature_pos); }
`;

describe("loadMpvUserShader", () => {
  it("splits on directive blocks and drops the pre-directive license header", () => {
    const { passes } = loadMpvUserShader(TWO_PASS, { name: "t" });
    expect(passes).toHaveLength(2);
    expect(passes[0].frag).not.toContain("license header");
    expect(passes[0].frag).toContain("vec4 hook()");
  });

  it("wires BIND names to the pass that last SAVEd them", () => {
    const { passes } = loadMpvUserShader(TWO_PASS, { name: "t" });
    expect(passes[0].inputs).toEqual([{ uniform: "MAIN", from: SOURCE }]);
    /* Second pass still reads the untouched source as MAIN, plus pass 0's output. */
    expect(passes[1].inputs).toEqual([
      { uniform: "MAIN", from: SOURCE },
      { uniform: "feature", from: "t#0" },
    ]);
  });

  it("emits the mpv macro surface each bound texture needs", () => {
    const { passes } = loadMpvUserShader(TWO_PASS, { name: "t" });
    for (const macro of ["MAIN_tex", "MAIN_texOff", "MAIN_pos", "MAIN_pt", "MAIN_size"]) {
      expect(passes[0].frag).toContain(`#define ${macro}`);
    }
    expect(passes[0].frag.startsWith("#version 300 es")).toBe(true);
    expect(passes[0].frag).toContain("void main() { prismFragColor = hook(); }");
  });

  /* The bug this pins down: the size closures used to resolve names through the live symbol
     table, which by render time had been mutated by every later SAVE - so pass 0's `MAIN.w`
     meant "whatever saved MAIN last", a pass further down that isn't allocated yet. A stub
     that returns one size for every name cannot see that, hence the name assertions. */
  it("resolves a pass's size against the bindings as they were at that pass", () => {
    const { passes } = loadMpvUserShader(TWO_PASS, { name: "t" });
    const asked = [];
    const ctx = {
      sourceW: 960,
      sourceH: 540,
      outW: 1920,
      outH: 1080,
      sizeOf: (n) => {
        asked.push(n);
        if (n === SOURCE || n === "t#0") return [960, 540];
        throw new Error(`resolved to "${n}", which is not allocated yet`);
      },
    };
    expect(passes[0].size(ctx)).toEqual([960, 540]);
    expect(asked).toContain(SOURCE);
    /* Pass 1 SAVEs MAIN, so a lazily-resolved pass 0 would have asked for t#1 here. */
    expect(asked).not.toContain("t#1");

    asked.length = 0;
    expect(passes[1].size(ctx)).toEqual([1920, 1080]);
    expect(asked).toContain("t#0");
  });

  it("rejects COMPUTE passes instead of half-running them", () => {
    const compute = TWO_PASS.replace("//!DESC first", "//!DESC first\n//!COMPUTE 8 8");
    expect(() => loadMpvUserShader(compute, { name: "t" })).toThrow(/COMPUTE/);
  });

  /* FSR 1's exact shape: EASU is gated and SAVEs a texture, RCAS carries no clause and binds
     it. Hoisting the one clause to the whole file is what reproduces mpv's behavior, where
     skipping the producer skips the consumer with it. */
  it("hoists a single WHEN clause to the whole file when only some passes carry it", () => {
    const gated = TWO_PASS.replace("//!DESC first", "//!DESC first\n//!WHEN OUTPUT.w MAIN.w / 1.2 >");
    const { when } = loadMpvUserShader(gated, { name: "t" });
    expect(when({ sourceW: 960, sourceH: 540, outW: 1920, outH: 1080 })).toBe(true);
    expect(when({ sourceW: 960, sourceH: 540, outW: 960, outH: 540 })).toBe(false);
  });

  it("rejects two genuinely different WHEN clauses, which would need per-pass gating", () => {
    const conflicting = TWO_PASS
      .replace("//!DESC first", "//!DESC first\n//!WHEN OUTPUT.w MAIN.w / 1.2 >")
      .replace("//!DESC second", "//!DESC second\n//!WHEN OUTPUT.w MAIN.w / 3.0 >");
    expect(() => loadMpvUserShader(conflicting, { name: "t" })).toThrow(/two different/);
  });
});

describe("loadMpvUserShaderChain", () => {
  it("feeds each file's MAIN from the previous file's output", () => {
    const { passes } = loadMpvUserShaderChain([
      { source: TWO_PASS, name: "a" },
      { source: TWO_PASS, name: "b" },
    ]);
    expect(passes).toHaveLength(4);
    /* File b's first pass must read file a's last pass, not the original source. */
    expect(passes[2].inputs).toEqual([{ uniform: "MAIN", from: "a#1" }]);
  });
});

/* Guards the vendored upstream files specifically: a re-download that changed directive
   shape (a new COMPUTE pass, a renamed hook target) would otherwise only show up as the
   preset quietly disappearing at runtime behind a console warning. */
describe("the vendored Anime4K CNN preset", () => {
  it("loads and registers", () => {
    expect(SHADER_TYPES.anime4k_cnn).toBeDefined();
  });

  it("ends in the present pass and reads the last CNN pass", () => {
    const { passes } = SHADER_TYPES.anime4k_cnn;
    const last = passes[passes.length - 1];
    expect(last.name).toBe("present");
    expect(last.inputs[0].from).toBe(passes[passes.length - 2].name);
  });

  it("chains Restore into Upscale for the documented 10 passes", () => {
    const { passes } = SHADER_TYPES.anime4k_cnn;
    expect(passes.filter((p) => p.name.startsWith("a4k-restore"))).toHaveLength(4);
    expect(passes.filter((p) => p.name.startsWith("a4k-upscale"))).toHaveLength(5);
  });

  it("carries Anime4K's own 1.2x upscale gate", () => {
    const { when } = SHADER_TYPES.anime4k_cnn;
    expect(when({ sourceW: 1920, sourceH: 1080, outW: 3840, outH: 2160 })).toBe(true);
    expect(when({ sourceW: 1920, sourceH: 1080, outW: 1920, outH: 1080 })).toBe(false);
  });

  /* Replays pass-chain.js's allocation loop exactly - each pass sized in order, only able to
     reference what came before - so a regression in name resolution fails here instead of
     only on a real GPU. */
  it("sizes every pass in allocation order, ending at 2x the source", () => {
    const { passes } = SHADER_TYPES.anime4k_cnn;
    const known = new Map([[SOURCE, [960, 540]]]);
    const ctx = {
      sourceW: 960,
      sourceH: 540,
      outW: 1920,
      outH: 1080,
      sizeOf: (n) => {
        const size = known.get(n);
        if (!size) throw new Error(`pass size references "${n}" before it is allocated`);
        return size;
      },
    };
    for (const pass of passes.slice(0, -1)) {
      known.set(pass.name, pass.size(ctx));
    }
    /* Anime4K's depth-to-space pass is the one that actually doubles the resolution. */
    expect(known.get(passes[passes.length - 2].name)).toEqual([1920, 1080]);
    /* Everything before it stays at source resolution. */
    expect(known.get(passes[0].name)).toEqual([960, 540]);
  });

  it("requires float render targets on every CNN pass", () => {
    const cnnPasses = SHADER_TYPES.anime4k_cnn.passes.filter((p) => p.name !== "present");
    expect(cnnPasses.every((p) => p.float === "required")).toBe(true);
  });
});

/* Same guard as the Anime4K block above, plus the luma sandwich this preset needs: FSR's mpv
   port reads and writes only `.r`, so an extract pass in front and a merge pass behind are what
   make it correct on an RGB source rather than a red-channel-only filter. */
describe("the vendored FSR 1 preset", () => {
  it("loads and registers", () => {
    expect(SHADER_TYPES.live_action_fsr).toBeDefined();
  });

  it("sandwiches FSR's two passes between luma extract and merge", () => {
    const names = SHADER_TYPES.live_action_fsr.passes.map((p) => p.name);
    expect(names).toEqual(["luma-extract", "fsr1#0", "fsr1#1", "luma-merge"]);
  });

  it("gives the merge pass both the original RGB and the reconstructed luma", () => {
    const { passes } = SHADER_TYPES.live_action_fsr;
    const merge = passes[passes.length - 1];
    expect(merge.inputs).toEqual([
      { uniform: "uSource", from: SOURCE },
      { uniform: "uLuma", from: "fsr1#1" },
    ]);
  });

  it("feeds EASU the extracted luma plane, not the RGB source", () => {
    const easu = SHADER_TYPES.live_action_fsr.passes[1];
    expect(easu.inputs).toEqual([{ uniform: "HOOKED", from: "luma-extract" }]);
  });

  /* Hoisted from EASU, which is the only pass carrying it - RCAS depends on EASU's output. */
  it("carries FSR's own any-upscale gate", () => {
    const { when } = SHADER_TYPES.live_action_fsr;
    expect(when({ sourceW: 1280, sourceH: 720, outW: 1920, outH: 1080 })).toBe(true);
    expect(when({ sourceW: 1920, sourceH: 1080, outW: 1920, outH: 1080 })).toBe(false);
  });

  it("caps EASU's output at 2x the source, per its own size expression", () => {
    const { passes } = SHADER_TYPES.live_action_fsr;
    const known = new Map([[SOURCE, [960, 540]]]);
    const ctx = {
      sourceW: 960,
      sourceH: 540,
      /* A display far beyond 2x, to prove the cap is EASU's and not the canvas's. */
      outW: 3840,
      outH: 2160,
      sizeOf: (n) => {
        const size = known.get(n);
        if (!size) throw new Error(`pass size references "${n}" before it is allocated`);
        return size;
      },
    };
    for (const pass of passes.slice(0, -1)) {
      known.set(pass.name, pass.size ? pass.size(ctx) : [960, 540]);
    }
    expect(known.get("luma-extract")).toEqual([960, 540]);
    expect(known.get("fsr1#0")).toEqual([1920, 1080]);
    expect(known.get("fsr1#1")).toEqual([1920, 1080]);
  });
});

/* Deband is the first optional pass, so it is also the first test of whether presets really are
   composable - every one of them has to hand its algorithm passes a different input symbol, and
   the mpv-loaded ones have to resolve their WIDTH/HEIGHT expressions against it too. */
describe("optional-pass composition", () => {
  const withDeband = (key) => SHADER_TYPES[key].buildPasses({ deband: true });

  it("leaves every preset unchanged when deband is off", () => {
    for (const [key, preset] of Object.entries(SHADER_TYPES)) {
      expect(preset.buildPasses({ deband: false }).map((p) => p.name), key).toEqual(preset.passes.map((p) => p.name));
    }
  });

  it("prepends deband at source resolution for every preset", () => {
    for (const key of Object.keys(SHADER_TYPES)) {
      const passes = withDeband(key);
      expect(passes[0].name, key).toBe("deband");
      expect(passes[0].inputs, key).toEqual([{ uniform: "uTex", from: SOURCE }]);
      expect(passes[0].scale, key).toBe(1);
      expect(passes).toHaveLength(SHADER_TYPES[key].passes.length + 1);
    }
  });

  it("rewires a sharpen preset to read the deband output instead of the source", () => {
    const passes = withDeband("live_action");
    expect(passes[1].inputs).toEqual([{ uniform: "uTex", from: "deband" }]);
  });

  it("rewires the CNN chain's first pass, and nothing later still reads SOURCE", () => {
    const passes = withDeband("anime4k_cnn");
    expect(passes[1].inputs[0].from).toBe("deband");
    const stillOnSource = passes.slice(1).flatMap((p) => p.inputs).filter((i) => i.from === SOURCE);
    expect(stillOnSource).toEqual([]);
  });

  /* Both halves of the luma sandwich must move: folding a debanded luma back into un-debanded RGB
     would leave the banding in the chroma-carrying channels. */
  it("rewires both luma-extract and luma-merge's RGB input", () => {
    const passes = withDeband("live_action_fsr");
    const extract = passes.find((p) => p.name === "luma-extract");
    const merge = passes.find((p) => p.name === "luma-merge");
    expect(extract.inputs).toEqual([{ uniform: "uTex", from: "deband" }]);
    expect(merge.inputs[0]).toEqual({ uniform: "uSource", from: "deband" });
  });

  /* The same allocation-order replay as the un-debanded case: with an extra pass in front, every
     size expression still has to resolve against something already allocated. */
  it("still sizes the CNN chain in allocation order with deband inserted", () => {
    const passes = withDeband("anime4k_cnn");
    const known = new Map([[SOURCE, [960, 540]]]);
    const ctx = {
      sourceW: 960,
      sourceH: 540,
      outW: 1920,
      outH: 1080,
      sizeOf: (n) => {
        const size = known.get(n);
        if (!size) throw new Error(`pass size references "${n}" before it is allocated`);
        return size;
      },
    };
    for (const pass of passes.slice(0, -1)) {
      known.set(pass.name, pass.size ? pass.size(ctx) : [960, 540]);
    }
    expect(known.get("deband")).toEqual([960, 540]);
    expect(known.get(passes[passes.length - 2].name)).toEqual([1920, 1080]);
  });
});
