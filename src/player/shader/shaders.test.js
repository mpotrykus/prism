import { describe, it, expect } from "vitest";
import { shaderTuningAt, detectShaderType, SHADER_TYPES } from "./shaders.js";

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
});
