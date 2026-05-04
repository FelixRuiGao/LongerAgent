import { describe, it, expect } from "bun:test";
import { DEFAULT_THRESHOLDS, computeHysteresisThresholds } from "../src/settings.js";

describe("settings module", () => {
  it("exposes the fixed default context thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      context_hint_level1: 60,
      context_hint_level2: 80,
      compact_before_turn: 85,
      compact_mid_turn: 90,
    });
  });

  it("keeps hint thresholds ordered below compact thresholds", () => {
    expect(DEFAULT_THRESHOLDS.context_hint_level1).toBeLessThanOrEqual(
      DEFAULT_THRESHOLDS.context_hint_level2,
    );
    expect(DEFAULT_THRESHOLDS.compact_before_turn).toBeLessThanOrEqual(
      DEFAULT_THRESHOLDS.compact_mid_turn,
    );
    expect(DEFAULT_THRESHOLDS.context_hint_level2).toBeLessThan(
      DEFAULT_THRESHOLDS.compact_before_turn,
    );
  });
});

describe("computeHysteresisThresholds", () => {
  it("derives correct values from default thresholds", () => {
    const h = computeHysteresisThresholds(DEFAULT_THRESHOLDS);
    expect(h.hintResetNone).toBe(40);
    expect(h.hintResetLevel1).toBe(70);
  });

  it("derives correct values from custom thresholds", () => {
    const h = computeHysteresisThresholds({
      context_hint_level1: 50,
      context_hint_level2: 70,
      compact_before_turn: 85,
      compact_mid_turn: 90,
    });
    expect(h.hintResetNone).toBe(30);
    expect(h.hintResetLevel1).toBe(60);
  });

  it("keeps reset thresholds below the trigger points", () => {
    const thresholds = {
      context_hint_level1: 65,
      context_hint_level2: 85,
      compact_before_turn: 88,
      compact_mid_turn: 92,
    };
    const h = computeHysteresisThresholds(thresholds);
    expect(h.hintResetNone).toBeLessThan(thresholds.context_hint_level1);
    expect(h.hintResetLevel1).toBeGreaterThanOrEqual(thresholds.context_hint_level1);
    expect(h.hintResetLevel1).toBeLessThan(thresholds.context_hint_level2);
  });
});
