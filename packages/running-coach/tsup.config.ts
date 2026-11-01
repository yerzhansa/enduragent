import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [/^@enduragent\//],
  banner: { js: "#!/usr/bin/env node" },
});
