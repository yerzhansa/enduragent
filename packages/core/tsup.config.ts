import { copyFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { jsonBytes } from "../../tools/model-catalog-bytes.js";
import { BUNDLED_MODEL_CATALOG_ARTIFACT } from "../../tools/bundled-model-catalog-artifact.js";
import { GENERATED_MODEL_CATALOG_SEED } from "./src/model-catalog-seed.generated.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const workoutChartFontPath = createRequire(import.meta.url).resolve(
  "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf",
);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  onSuccess() {
    copyFileSync(workoutChartFontPath, join(packageRoot, "dist/workout-chart-font.otf"));
    copyFileSync(
      join(packageRoot, "src/channels/workout-chart-font.LICENSE.txt"),
      join(packageRoot, "dist/workout-chart-font.LICENSE.txt"),
    );
    writeFileSync(
      join(packageRoot, "dist", BUNDLED_MODEL_CATALOG_ARTIFACT),
      jsonBytes(GENERATED_MODEL_CATALOG_SEED),
    );
  },
});
