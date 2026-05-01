import { describe, it, expect } from "bun:test";
import { DEFAULT_THRESHOLDS, computeHysteresisThresholds } from "../src/settings.js";

describe("settings module", () => {
  it("exposes the fixed default context thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      summarize_hint_level1: 60,
      summarize_hint_level2: 80,
      compact_output: 85,
      compact_toolcall: 90,
    });
  });

  it("keeps summarize thresholds ordered below compact thresholds", () => {
    expect(DEFAULT_THRESHOLDS.summarize_hint_level1).toBeLessThanOrEqual(
      DEFAULT_THRESHOLDS.summarize_hint_level2,
    );
    expect(DEFAULT_THRESHOLDS.compact_output).toBeLessThanOrEqual(
      DEFAULT_THRESHOLDS.compact_toolcall,
    );
    expect(DEFAULT_THRESHOLDS.summarize_hint_level2).toBeLessThan(
      DEFAULT_THRESHOLDS.compact_output,
    );
  });
});

describe("computeHysteresisThresholds", () => {
  it("derives correct values from default thresholds", () => {
    const h = computeHysteresisThresholds(DEFAULT_THRESHOLDS);
    // hintResetNone = 60 - 20 = 40
    expect(h.hintResetNone).toBe(40);
    // hintResetLevel1 = (60 + 80) / 2 = 70
    expect(h.hintResetLevel1).toBe(70);
  });

  it("derives correct values from custom thresholds", () => {
    const h = computeHysteresisThresholds({
      summarize_hint_level1: 50,
      summarize_hint_level2: 70,
      compact_output: 85,
      compact_toolcall: 90,
    });
    expect(h.hintResetNone).toBe(30);
    expect(h.hintResetLevel1).toBe(60);
  });

  it("keeps reset thresholds below the trigger points", () => {
    const thresholds = {
      summarize_hint_level1: 65,
      summarize_hint_level2: 85,
      compact_output: 88,
      compact_toolcall: 92,
    };
    const h = computeHysteresisThresholds(thresholds);
    expect(h.hintResetNone).toBeLessThan(thresholds.summarize_hint_level1);
    expect(h.hintResetLevel1).toBeGreaterThanOrEqual(thresholds.summarize_hint_level1);
    expect(h.hintResetLevel1).toBeLessThan(thresholds.summarize_hint_level2);
  });
});
