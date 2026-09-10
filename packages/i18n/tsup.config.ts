import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    messages: "src/messages.ts",
    react: "src/react.tsx",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  platform: "neutral",
  target: "es2022",
});
