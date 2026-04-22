import { afterEach, describe, expect, it, vi } from "vitest";

describe("CLI startup", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env["VIGIL_TEST_KEY"];
  });

  it("loads dotenv before dispatching the init subcommand", async () => {
    const events: string[] = [];

    vi.doMock("../src/dotenv.js", () => ({
      loadDotenv: () => {
        events.push("dotenv");
        process.env["VIGIL_TEST_KEY"] = "loaded";
      },
    }));

    vi.doMock("../src/init-wizard.js", () => ({
      runInitWizard: async () => {
        events.push(`init:${process.env["VIGIL_TEST_KEY"] ?? "missing"}`);
        return { homeDir: "/tmp/vigil-test" };
      },
    }));

    const { main } = await import("../src/cli.js");
    await main(["node", "vigil", "init"]);

    expect(events).toEqual(["dotenv", "init:loaded"]);
  });
});
