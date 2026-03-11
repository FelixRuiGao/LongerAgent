import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAssetPaths } from "../src/config.js";
import { loadDotenv } from "../src/dotenv.js";
import { getLongerAgentHomeDir } from "../src/home-path.js";
import { SessionStore } from "../src/persistence.js";

describe("fixed LongerAgent home directory", () => {
  const originalHome = process.env["HOME"];
  const originalLongerAgentHome = process.env["LONGERAGENT_HOME"];
  let tempHome: string;
  let legacyOverride: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "longeragent-home-"));
    legacyOverride = mkdtempSync(join(tmpdir(), "longeragent-legacy-home-"));
    process.env["HOME"] = tempHome;
    process.env["LONGERAGENT_HOME"] = legacyOverride;
    delete process.env["LONGERAGENT_TEST_KEY"];
  });

  afterEach(() => {
    delete process.env["LONGERAGENT_TEST_KEY"];
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalLongerAgentHome === undefined) {
      delete process.env["LONGERAGENT_HOME"];
    } else {
      process.env["LONGERAGENT_HOME"] = originalLongerAgentHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(legacyOverride, { recursive: true, force: true });
  });

  it("ignores LONGERAGENT_HOME when resolving the global home directory", () => {
    expect(getLongerAgentHomeDir()).toBe(join(tempHome, ".longeragent"));
  });

  it("loads .env from the fixed home directory by default", () => {
    const homeDir = getLongerAgentHomeDir();
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, ".env"), "LONGERAGENT_TEST_KEY=from-home\n", "utf-8");

    mkdirSync(legacyOverride, { recursive: true });
    writeFileSync(join(legacyOverride, ".env"), "LONGERAGENT_TEST_KEY=from-legacy\n", "utf-8");

    loadDotenv();

    expect(process.env["LONGERAGENT_TEST_KEY"]).toBe("from-home");
  });

  it("stores global preferences under the fixed home directory", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "longeragent-project-"));
    try {
      const store = new SessionStore({ projectPath: projectRoot });
      store.saveGlobalPreferences({
        modelConfigName: "openai:gpt-5.4",
      });

      expect(existsSync(join(getLongerAgentHomeDir(), "tui-preferences.json"))).toBe(true);
      expect(existsSync(join(legacyOverride, "tui-preferences.json"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves asset overrides from the fixed home directory", () => {
    const homeTemplates = join(getLongerAgentHomeDir(), "agent_templates");
    const legacyTemplates = join(legacyOverride, "agent_templates");
    mkdirSync(homeTemplates, { recursive: true });
    mkdirSync(legacyTemplates, { recursive: true });

    const paths = resolveAssetPaths();

    expect(paths.homeDir).toBe(join(tempHome, ".longeragent"));
    expect(paths.templatesPath).toBe(homeTemplates);
  });
});
