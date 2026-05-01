import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

describe("CLI startup", () => {
  afterEach(() => {
    mock.restore();
    delete process.env["FERMI_TEST_KEY"];
  });

  it("loads dotenv before dispatching the init subcommand", async () => {
    const events: string[] = [];

    mock.module("../src/dotenv.js", () => ({
      loadDotenv: () => {
        events.push("dotenv");
        process.env["FERMI_TEST_KEY"] = "loaded";
      },
      setDotenvKey: () => {},
    }));

    mock.module("../src/init-wizard.js", () => ({
      runInitWizard: async () => {
        events.push(`init:${process.env["FERMI_TEST_KEY"] ?? "missing"}`);
        return { homeDir: "/tmp/fermi-test" };
      },
    }));

    const { main } = await import("../src/cli.js");
    await main(["node", "fermi", "init"]);

    expect(events).toEqual(["dotenv", "init:loaded"]);
  });
});
