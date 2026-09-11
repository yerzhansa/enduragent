import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createWindowsDevelopmentPackagePlan } from "../scripts/windows-development-package-plan.mjs";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-feed.js";
import { createWindowsPackagePlan } from "../scripts/windows-package-plan.mjs";
import {
  WINDOWS_AUTHENTICODE_PENDING,
  WINDOWS_PUBLISHER_DN_PLACEHOLDER,
  assertKnownWindowsReleaseAssets,
  createWindowsReleasePlan,
  parseWindowsReleaseUpdaterMetadata,
  safeWindowsReleasePlanMessage,
  serializeWindowsReleaseUpdaterMetadata,
  windowsReleaseArtifactNames,
  windowsReleaseAssetNames,
  windowsUpdaterMetadataDigest,
} from "../scripts/windows-release-plan.mjs";

const feedUrl = DESKTOP_FEED_URL;
const commit = "a".repeat(40);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.1.5",
    commit,
    feedUrl,
    mode: "steady" as const,
    baselineVersion: "0.1.2",
    repositoryRoot: "/synthetic/repository",
    desktopRoot: "/synthetic/repository/apps/desktop",
    ...overrides,
  };
}

describe("Windows release plan", () => {
  it("freezes the exact Windows asset names", () => {
    const names = windowsReleaseArtifactNames("0.1.5");
    expect(names).toEqual({
      installer: "Enduragent-0.1.5-x64.exe",
      blockmap: "Enduragent-0.1.5-x64.exe.blockmap",
      metadata: "latest.yml",
    });
    expect(windowsReleaseAssetNames("0.1.5")).toEqual([
      "Enduragent-0.1.5-x64.exe",
      "Enduragent-0.1.5-x64.exe.blockmap",
      "latest.yml",
    ]);
    expect(Object.isFrozen(names)).toBe(true);
  });

  it("rejects duplicate, unknown, and missing Windows release assets", () => {
    const names = windowsReleaseAssetNames("0.1.5");
    expect(() => assertKnownWindowsReleaseAssets([...names, names[0]!], "0.1.5")).toThrow(
      `duplicate Windows release asset: ${names[0]}`,
    );
    expect(() => assertKnownWindowsReleaseAssets([...names, "old.zip"], "0.1.5")).toThrow(
      "unknown Windows release asset: old.zip",
    );
    expect(() => assertKnownWindowsReleaseAssets(names.slice(1), "0.1.5")).toThrow(
      `missing Windows release asset: ${names[0]}`,
    );
  });

  it("enforces genesis and steady baseline rules while allowing lag", () => {
    expect(() =>
      createWindowsReleasePlan(planInput({ mode: "genesis", baselineVersion: "0.1.2" })),
    ).toThrow("genesis Windows release must not name a baseline");
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: undefined }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: "0.1.5" }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: "0.1.6" }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(createWindowsReleasePlan(planInput()).baselineVersion).toBe("0.1.2");
  });

  it("parses exact updater identity with an optional publisher", () => {
    const base = {
      provider: "generic",
      url: feedUrl,
      channel: "latest",
      updaterCacheDirName: "@enduragentdesktop-updater",
    };
    expect(parseWindowsReleaseUpdaterMetadata(stringify(base))).toEqual(base);
    const publisherName = "CN=Enduragent Test";
    expect(
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName }), {
        expectedPublisherName: publisherName,
      }),
    ).toEqual({ ...base, publisherName });
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName }), {
        expectedPublisherName: "CN=Different Publisher",
      }),
    ).toThrow("release updater publisher name mismatch");
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, unexpected: true })),
    ).toThrow("release updater metadata is invalid");
    expect(
      parseWindowsReleaseUpdaterMetadata(
        stringify({ ...base, publisherName: [WINDOWS_PUBLISHER_DN_PLACEHOLDER] }),
        { expectedPublisherName: WINDOWS_PUBLISHER_DN_PLACEHOLDER },
      ).publisherName,
    ).toBe(WINDOWS_PUBLISHER_DN_PLACEHOLDER);
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName: ["a", "b"] })),
    ).toThrow("release updater metadata is invalid");
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName: [] })),
    ).toThrow("release updater metadata is invalid");
  });

  it("creates the signed NSIS builder contract with differential packaging", () => {
    const plan = createWindowsReleasePlan(planInput());
    expect(plan).toMatchObject({
      version: "0.1.5",
      commit,
      tag: "enduragent-desktop@0.1.5",
      platform: "win32",
      arch: "x64",
      mode: "steady",
      authenticode: WINDOWS_AUTHENTICODE_PENDING,
      publisherDn: WINDOWS_PUBLISHER_DN_PLACEHOLDER,
      publisherDnIsPlaceholder: true,
    });
    expect(plan.builderOptions.config.forceCodeSigning).toBe(true);
    expect(plan.builderOptions.config.nsis.differentialPackage).toBe(true);
    expect(plan.builderOptions.config.publish).toEqual([
      { provider: "generic", url: feedUrl, channel: "latest" },
    ]);
    expect(plan.builderOptions.publish).toBe("never");
    expect(plan.builderOptions.config.win).toEqual({
      signtoolOptions: { publisherName: [WINDOWS_PUBLISHER_DN_PLACEHOLDER] },
      signExecutable: true,
      verifyUpdateCodeSignature: true,
      legalTrademarks: `enduragent-release-commit:${commit} enduragent-updater-publisher-sha256:${createHash("sha256").update(WINDOWS_PUBLISHER_DN_PLACEHOLDER).digest("hex")} enduragent-updater-metadata-sha256:${plan.updaterMetadataSha256}`,
      target: [{ target: "nsis", arch: ["x64"] }],
    });
    const canonicalUpdaterMetadata = serializeWindowsReleaseUpdaterMetadata(
      feedUrl,
      WINDOWS_PUBLISHER_DN_PLACEHOLDER,
    );
    expect(plan.updaterMetadataSha256).toBe(
      windowsUpdaterMetadataDigest(canonicalUpdaterMetadata),
    );
    expect(parse(canonicalUpdaterMetadata.toString("utf8"))).toEqual({
      provider: "generic",
      url: feedUrl,
      channel: "latest",
      updaterCacheDirName: "@enduragentdesktop-updater",
      publisherName: [WINDOWS_PUBLISHER_DN_PLACEHOLDER],
    });
    expect(plan.updaterMetadata.publisherName).toBe(WINDOWS_PUBLISHER_DN_PLACEHOLDER);
    const customPublisherDn = "CN=Enduragent Test Publisher, O=Enduragent Test";
    const customPlan = createWindowsReleasePlan(planInput({ publisherDn: customPublisherDn }));
    expect(customPlan.publisherDn).toBe(customPublisherDn);
    expect(customPlan.publisherDnIsPlaceholder).toBe(false);
    expect(customPlan.builderOptions.config.win.signtoolOptions.publisherName).toEqual([
      customPublisherDn,
    ]);
    expect(customPlan.updaterMetadata.publisherName).toBe(customPublisherDn);
    expect(() => createWindowsReleasePlan(planInput({ publisherDn: "  " }))).toThrow(
      "Windows publisher DN is invalid",
    );
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("release config passes the electron-builder 26.15.3 schema", () => {
    const plan = createWindowsReleasePlan(planInput());
    const { extends: _extends, ...config } = plan.builderOptions.config;
    const require = createRequire(import.meta.url);
    const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
    const schema = JSON.parse(
      readFileSync(electronBuilderRequire.resolve("app-builder-lib/scheme.json"), "utf8"),
    );
    try {
      const appBuilderRequire = createRequire(
        electronBuilderRequire.resolve("app-builder-lib/package.json"),
      );
      const AjvModule = appBuilderRequire("ajv");
      const Ajv = AjvModule.default ?? AjvModule;
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(schema);
      expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
    } catch (error) {
      if (error instanceof Error && !/Cannot find module/u.test(error.message)) throw error;
      expect(config.win).not.toHaveProperty("publisherName");
      expect(config.win.signtoolOptions.publisherName).toEqual([
        WINDOWS_PUBLISHER_DN_PLACEHOLDER,
      ]);
      expect(Object.keys(config.win).every((key) => key in schema.definitions.WindowsConfiguration.properties)).toBe(true);
    }
    const base = parse(readFileSync(resolve(desktopRoot, "electron-builder.yml"), "utf8"));
    const merged = {
      ...base,
      ...plan.builderOptions.config,
      win: { ...base.win, ...plan.builderOptions.config.win },
      nsis: { ...base.nsis, ...plan.builderOptions.config.nsis },
    };
    expect(merged.win.signExecutable).toBe(true);
  });

  it("forceCodeSigning implies signExecutable", async () => {
    const release = createWindowsReleasePlan(planInput());
    expect(release.builderOptions.config.forceCodeSigning).toBe(true);
    expect(release.builderOptions.config.win.signExecutable).toBe(true);
    const packagePlan = await createWindowsPackagePlan(
      { desktopRoot: "/synthetic/repository/apps/desktop" },
      { readFile: async () => JSON.stringify({ version: "0.1.5" }) },
    );
    const developmentPlan = createWindowsDevelopmentPackagePlan({
      desktopRoot: "/synthetic/repository/apps/desktop",
    });
    expect(packagePlan.builderOptions.config.forceCodeSigning).toBe(false);
    expect(developmentPlan.builderOptions.config.forceCodeSigning).toBe(false);
  });

  it("exposes only safe planner failures", () => {
    expect(
      safeWindowsReleasePlanMessage(
        new TypeError("steady Windows release requires a lower stable baseline version"),
      ),
    ).toBe("steady Windows release requires a lower stable baseline version");
    expect(safeWindowsReleasePlanMessage(new Error("foreign"))).toBeUndefined();
  });
});
