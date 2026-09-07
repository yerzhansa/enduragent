import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, loadConfigFromFile, mergeConfig, type Plugin, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(import.meta.dirname, "..");
const verificationModule =
  /(?:^|\/)(?:preview|\.storybook|tests|fixtures)\/|\.stories\.[cm]?[jt]sx?(?:\?|$)/u;

function releaseGuard(): Plugin {
  return {
    name: "verify-release-verification-isolation",
    moduleParsed(module) {
      if (verificationModule.test(module.id)) {
        throw new Error(`Release imports verification module: ${module.id}`);
      }
    },
    generateBundle() {
      const modules = [...this.getModuleIds()];
      if (
        !modules.some((id) => id.endsWith("/src/main.tsx")) ||
        !modules.some((id) => id.endsWith("/tray.html"))
      ) {
        throw new Error("Release graph omitted a production renderer entry");
      }
      for (const id of modules) {
        if (verificationModule.test(id))
          throw new Error(`Release imports verification module: ${id}`);
      }
    },
  };
}

async function rendererConfig(kind: "standalone" | "desktop"): Promise<UserConfig> {
  const path =
    kind === "standalone"
      ? resolve(rendererRoot, "vite.config.ts")
      : resolve(rendererRoot, "../desktop/electron.vite.config.ts");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, path);
  if (loaded === null) throw new Error(`Missing release configuration: ${path}`);
  if (kind === "standalone") {
    return mergeConfig(loaded.config, { root: rendererRoot, plugins: [tailwindcss()] });
  }
  const candidate = "renderer" in loaded.config ? loaded.config.renderer : undefined;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Desktop configuration omitted the renderer");
  }
  return mergeConfig(candidate, {});
}

describe("release verification isolation", () => {
  it.each(["standalone", "desktop"] as const)(
    "excludes verification code from the %s release graph",
    async (kind) => {
      const config = await rendererConfig(kind);
      await build(
        mergeConfig(config, {
          configFile: false,
          logLevel: "silent",
          plugins: [releaseGuard()],
          build: { write: false, minify: false, reportCompressedSize: false },
        }),
      );
    },
    60_000,
  );

  it.each(["preview", "fixtures"])(
    "rejects a transitive %s import before tree shaking",
    async (directory) => {
      const fixtureId = resolve(rendererRoot, directory, "runtime-regression.ts");
      const injectFixture: Plugin = {
        name: "inject-verification-import-regression",
        enforce: "pre",
        resolveId(id) {
          return id === "virtual:verification-regression" ? fixtureId : null;
        },
        load(id) {
          return id === fixtureId ? "export const unused = true;" : null;
        },
        transform(code, id) {
          return id === resolve(rendererRoot, "src/theme/preferences.ts")
            ? `import "virtual:verification-regression";\n${code}`
            : null;
        },
      };
      await expect(
        build(
          mergeConfig(await rendererConfig("standalone"), {
            configFile: false,
            logLevel: "silent",
            plugins: [injectFixture, releaseGuard()],
            build: { write: false, minify: false, reportCompressedSize: false },
          }),
        ),
      ).rejects.toThrow("Release imports verification module:");
    },
    60_000,
  );
});
