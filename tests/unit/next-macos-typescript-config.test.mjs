import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
test("macOS development loads TypeScript configuration without spawning the CLI", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const { default: config } = await import("../../next.config.mjs");
    if (process.platform === "darwin") {
      assert.equal(config.experimental.useTypeScriptCli, false);
      const loadJsConfig = require("next/dist/build/load-jsconfig.js").default;
      const result = await loadJsConfig(process.cwd(), config);
      assert.deepEqual(result.jsConfig.compilerOptions.paths["@/*"], ["./src/*"]);
    } else {
      assert.equal(config.experimental.useTypeScriptCli, undefined);
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
