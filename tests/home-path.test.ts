import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAssetPaths } from "../src/config.js";
import { loadDotenv } from "../src/dotenv.js";
import { getFermiHomeDir } from "../src/home-path.js";
import { SessionStore } from "../src/persistence.js";

describe("fixed Fermi home directory", () => {
  const originalHome = process.env["HOME"];
  const originalFermiHome = process.env["FERMI_HOME"];
  let tempHome: string;
  let legacyOverride: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "fermi-home-"));
    legacyOverride = mkdtempSync(join(tmpdir(), "fermi-legacy-home-"));
    process.env["HOME"] = tempHome;
    process.env["FERMI_HOME"] = legacyOverride;
    delete process.env["FERMI_TEST_KEY"];
  });

  afterEach(() => {
    delete process.env["FERMI_TEST_KEY"];
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalFermiHome === undefined) {
      delete process.env["FERMI_HOME"];
    } else {
      process.env["FERMI_HOME"] = originalFermiHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(legacyOverride, { recursive: true, force: true });
  });

  it("ignores FERMI_HOME when resolving the global home directory", () => {
    expect(getFermiHomeDir()).toBe(join(tempHome, ".fermi"));
  });

  it("loads .env from the fixed home directory by default", () => {
    const homeDir = getFermiHomeDir();
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, ".env"), "FERMI_TEST_KEY=from-home\n", "utf-8");

    mkdirSync(legacyOverride, { recursive: true });
    writeFileSync(join(legacyOverride, ".env"), "FERMI_TEST_KEY=from-legacy\n", "utf-8");

    loadDotenv();

    expect(process.env["FERMI_TEST_KEY"]).toBe("from-home");
  });

  it("stores global preferences under the fixed home directory", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "fermi-project-"));
    try {
      const store = new SessionStore({ projectPath: projectRoot });
      store.saveGlobalPreferences({
        modelConfigName: "openai:gpt-5.4",
      });

      expect(existsSync(join(getFermiHomeDir(), "tui-preferences.json"))).toBe(true);
      expect(existsSync(join(legacyOverride, "tui-preferences.json"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves asset overrides from the fixed home directory", () => {
    const homeTemplates = join(getFermiHomeDir(), "agent_templates");
    const legacyTemplates = join(legacyOverride, "agent_templates");
    mkdirSync(homeTemplates, { recursive: true });
    mkdirSync(legacyTemplates, { recursive: true });

    const paths = resolveAssetPaths();

    expect(paths.homeDir).toBe(join(tempHome, ".fermi"));
    expect(paths.templatesPath).toBe(homeTemplates);
  });
});
