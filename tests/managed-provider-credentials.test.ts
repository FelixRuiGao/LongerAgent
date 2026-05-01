import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Config } from "../src/config.js";

const ENV_VARS = [
  "FERMI_GLM_API_KEY",
  "FERMI_GLM_INTL_API_KEY",
  "FERMI_GLM_CODE_API_KEY",
  "FERMI_GLM_INTL_CODE_API_KEY",
  "FERMI_KIMI_API_KEY",
  "FERMI_KIMI_CN_API_KEY",
  "FERMI_KIMI_CODE_API_KEY",
  "FERMI_MINIMAX_API_KEY",
  "FERMI_MINIMAX_CN_API_KEY",
];

const savedEnv = new Map<string, string | undefined>();

describe("managed provider credentials", () => {
  beforeEach(() => {
    savedEnv.clear();
    for (const envVar of ENV_VARS) {
      savedEnv.set(envVar, process.env[envVar]);
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const [envVar, value] of savedEnv.entries()) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    savedEnv.clear();
  });

  it("auto-registers managed provider models from Fermi env slots", () => {
    process.env["FERMI_GLM_CODE_API_KEY"] = "glm-code-secret";

    const cfg = new Config({});

    expect(cfg.modelNames).toContain("glm-code:glm-5");
    expect(cfg.modelNames).toContain("glm-code:glm-4.7");
    expect(cfg.getModel("glm-code:glm-5").apiKey).toBe("glm-code-secret");
  });

  it("does not share managed credentials across endpoints", () => {
    process.env["FERMI_GLM_API_KEY"] = "glm-standard-secret";

    const cfg = new Config({});

    expect(cfg.modelNames).toContain("glm:glm-5");
    expect(cfg.modelNames).not.toContain("glm-code:glm-5");
  });
});
