import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "model-catalog": "src/model-catalog.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
});
