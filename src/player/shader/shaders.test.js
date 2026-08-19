import { describe, it, expect } from "vitest";
import {
  shaderTuningAt,
  colorBoostAt,
  detectShaderType,
  autoUpscaleStrength,
  autoColorBoostStrength,
  autoContrastBoostStrength,
  SHADER_TYPES,
  COLOR_BOOST_TUNING,
} from "./shaders.js";

describe("detectShaderType", () => {
  it("picks anime4k for anime/animation genres", () => {
    expect(detectShaderType(["Animation"])).toBe("anime4k");
    expect(detectShaderType(["Anime"])).toBe("anime4k");
  });
  it("picks live_action for everything else", () => {
    expect(detectShaderType(["Drama", "Thriller"])).toBe("live_action");
    expect(detectShaderType([])).toBe("live_action");
    expect(detectShaderType(undefined)).toBe("live_action");
  });
});

describe("shaderTuningAt", () => {
  it("returns the min tuning at strength 0", () => {
    const tuning = shaderTuningAt("anime4k", 0);
    expect(tuning).toEqual(SHADER_TYPES.anime4k.min);
  });

  it("returns the max tuning at strength 1", () => {
    const tuning = shaderTuningAt("anime4k", 1);
    expect(tuning).toEqual(SHADER_TYPES.anime4k.max);
  });

  it("interpolates linearly for a type with no rampToMaxAt", () => {
    const tuning = shaderTuningAt("anime4k", 0.5);
    expect(tuning.scale).toBeCloseTo((1.8 + 2.4) / 2);
  });

  it("reaches max tuning early for live_action's rampToMaxAt", () => {
    const atRamp = shaderTuningAt("live_action", 0.15);
    const beyondRamp = shaderTuningAt("live_action", 0.9);
    expect(atRamp).toEqual(SHADER_TYPES.live_action.max);
    expect(beyondRamp).toEqual(SHADER_TYPES.live_action.max);
  });

  it("carries no saturation/contrast knobs - those moved to colorBoostAt", () => {
    expect(SHADER_TYPES.anime4k.min).not.toHaveProperty("saturation");
    expect(SHADER_TYPES.anime4k.min).not.toHaveProperty("contrast");
    expect(SHADER_TYPES.live_action.max).not.toHaveProperty("saturation");
    expect(SHADER_TYPES.live_action.max).not.toHaveProperty("contrast");
  });
});

describe("colorBoostAt", () => {
  it("is neutral (no boost) at strength 0/0", () => {
    expect(colorBoostAt(0, 0)).toEqual({
      saturation: COLOR_BOOST_TUNING.saturation.min,
      contrast: COLOR_BOOST_TUNING.contrast.min,
    });
  });

  it("reaches max boost at strength 1/1", () => {
    expect(colorBoostAt(1, 1)).toEqual({
      saturation: COLOR_BOOST_TUNING.saturation.max,
      contrast: COLOR_BOOST_TUNING.contrast.max,
    });
  });

  it("clamps each strength outside 0-1 independently", () => {
    expect(colorBoostAt(-1, 2)).toEqual({
      saturation: COLOR_BOOST_TUNING.saturation.min,
      contrast: COLOR_BOOST_TUNING.contrast.max,
    });
  });

  it("resolves saturation and contrast independently of one another", () => {
    expect(colorBoostAt(1, 0)).toEqual({
      saturation: COLOR_BOOST_TUNING.saturation.max,
      contrast: COLOR_BOOST_TUNING.contrast.min,
    });
    expect(colorBoostAt(0, 1)).toEqual({
      saturation: COLOR_BOOST_TUNING.saturation.min,
      contrast: COLOR_BOOST_TUNING.contrast.max,
    });
  });

  it("is independent of shader-upscale type/strength", () => {
    expect(colorBoostAt(0.5, 0.5)).toEqual(colorBoostAt(0.5, 0.5));
  });
});

describe("autoUpscaleStrength", () => {
  it("applies a baseline floor at or under native resolution rather than dropping to 0", () => {
    expect(autoUpscaleStrength({ scaleFactor: 1, edgeEnergy: 0 })).toBeCloseTo(0.15);
    expect(autoUpscaleStrength({ scaleFactor: 0.5, edgeEnergy: 0 })).toBeCloseTo(0.15);
  });

  it("rises toward 1 as the required upscale ratio grows", () => {
    const low = autoUpscaleStrength({ scaleFactor: 1.5, edgeEnergy: 0 });
    const high = autoUpscaleStrength({ scaleFactor: 2.5, edgeEnergy: 0 });
    expect(high).toBeGreaterThan(low);
    expect(autoUpscaleStrength({ scaleFactor: 3, edgeEnergy: 0 })).toBe(1);
    expect(autoUpscaleStrength({ scaleFactor: 10, edgeEnergy: 0 })).toBe(1);
  });

  it("damps but never eliminates the resolution-driven need when content already looks detailed", () => {
    const base = autoUpscaleStrength({ scaleFactor: 3, edgeEnergy: 0 });
    const damped = autoUpscaleStrength({ scaleFactor: 3, edgeEnergy: 1 });
    expect(damped).toBeLessThan(base);
    expect(damped).toBeGreaterThanOrEqual(base * 0.6);
  });

  it("clamps edgeEnergy outside 0-1", () => {
    expect(autoUpscaleStrength({ scaleFactor: 3, edgeEnergy: -5 })).toBe(1);
    expect(autoUpscaleStrength({ scaleFactor: 3, edgeEnergy: 5 })).toBeCloseTo(0.6);
  });
});

describe("autoColorBoostStrength", () => {
  it("is 0 once the frame is already vivid enough", () => {
    expect(autoColorBoostStrength({ avgSaturation: 0.2 })).toBe(0);
    expect(autoColorBoostStrength({ avgSaturation: 1 })).toBe(0);
  });

  it("is 1 for a fully desaturated (gray) frame", () => {
    expect(autoColorBoostStrength({ avgSaturation: 0.04 })).toBe(1);
    expect(autoColorBoostStrength({ avgSaturation: 0 })).toBe(1);
  });

  it("interpolates between the low/high saturation thresholds", () => {
    const t = autoColorBoostStrength({ avgSaturation: 0.12 });
    expect(t).toBeCloseTo(0.5);
  });
});

describe("autoContrastBoostStrength", () => {
  it("is 0 once the frame already spans a wide tonal range", () => {
    expect(autoContrastBoostStrength({ lumaStdDev: 0.28 })).toBe(0);
    expect(autoContrastBoostStrength({ lumaStdDev: 1 })).toBe(0);
  });

  it("is 1 for a flat, washed-out frame", () => {
    expect(autoContrastBoostStrength({ lumaStdDev: 0.1 })).toBe(1);
    expect(autoContrastBoostStrength({ lumaStdDev: 0 })).toBe(1);
  });

  it("interpolates between the low/high stdDev thresholds", () => {
    const t = autoContrastBoostStrength({ lumaStdDev: 0.19 });
    expect(t).toBeCloseTo(0.5);
  });

  it("is independent of autoColorBoostStrength - different signal, different result", () => {
    const sameInput = 0.15;
    expect(autoContrastBoostStrength({ lumaStdDev: sameInput })).not.toBe(
      autoColorBoostStrength({ avgSaturation: sameInput })
    );
  });
});
