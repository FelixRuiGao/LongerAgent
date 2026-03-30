import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.scm"],
  test: {
    include: [
      "tests/**/*.test.ts",
      // Keep the OpenTUI app-layer tests active without pulling in the
      // Bun/Wasm-heavy local core fork suites.
      "opentui-src/transcript/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "opentui-src/forked/core/**",
    ],
  },
});
