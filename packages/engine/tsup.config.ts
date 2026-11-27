import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sport: "src/sport.ts",
    calendar: "src/calendar.ts",
    "coach-text-writer": "src/coach-text-writer.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  removeNodeProtocol: false,
});
