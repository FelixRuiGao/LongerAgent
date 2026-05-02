import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadDotenv } from "../src/dotenv.js";
import { getFermiHomeDir } from "../src/home-path.js";
import { SessionStore } from "../src/persistence.js";

describe("fixed Fermi home directory", () => {
  let tempHome: string;
  let tempFermiHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "fermi-home-"));
    tempFermiHome = join(tempHome, ".fermi");
    mkdirSync(tempFermiHome, { recursive: true });
  });

  afterEach(() => {
    delete process.env["FERMI_TEST_KEY"];
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns a fixed path under the user home directory", () => {
    const home = getFermiHomeDir();
    expect(home).toMatch(/\.fermi$/);
  });

  it("loads .env from a specified home directory", () => {
    writeFileSync(join(tempFermiHome, ".env"), "FERMI_TEST_KEY=from-home\n", "utf-8");

    loadDotenv(tempFermiHome);

    expect(process.env["FERMI_TEST_KEY"]).toBe("from-home");
  });

  it("stores global preferences under the specified base directory", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "fermi-project-"));
    try {
      const store = new SessionStore({ projectPath: projectRoot, baseDir: tempFermiHome });
      store.saveGlobalPreferences({
        modelConfigName: "openai:gpt-5.4",
      });

      expect(existsSync(join(tempFermiHome, "tui-preferences.json"))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
