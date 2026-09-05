import { describe, expect, it, vi } from "vitest";
import {
  configureTelegramAcceptanceSigningEnvironment,
  createTelegramAcceptanceBuilderConfiguration,
  selectTelegramAcceptanceNestedTarget,
  TELEGRAM_ACCEPTANCE_APP_ID,
  TELEGRAM_ACCEPTANCE_ENTITLEMENTS,
  TELEGRAM_ACCEPTANCE_MARKER,
  TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
  TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  verifyTelegramAcceptanceDesignatedRequirement,
  verifyTelegramAcceptanceEntitlements,
  verifyTelegramAcceptanceInfoPlist,
  verifyTelegramAcceptanceMainEntry,
  verifyTelegramAcceptanceManifest,
  verifyTelegramAcceptanceNestedEntitlements,
  verifyTelegramAcceptanceNestedListing,
  verifyTelegramAcceptanceNestedSignature,
  verifyTelegramAcceptanceSignature,
  verifyTelegramAcceptanceWorkspaceRuntime,
} from "../scripts/support/packaged-telegram/package-acceptance.mjs";

const version = "0.0.1";
const cdHash = "0123456789abcdef0123456789abcdef01234567";

function canonicalBuilder() {
  return {
    appId: "icu.enduragent.desktop",
    productName: "Enduragent",
    directories: { output: "dist" },
    files: ["out/**", "package.json", "!**/*.map"],
    extraMetadata: { name: "@enduragent/desktop", retained: true },
    mac: {
      identity: "Developer ID Application: Production (ABCDE12345)",
      hardenedRuntime: true,
      target: [{ target: "dir", arch: ["arm64"] }],
    },
  };
}

function signature(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `Identifier=${overrides.Identifier ?? TELEGRAM_ACCEPTANCE_APP_ID}`,
    `Signature=${overrides.Signature ?? "adhoc"}`,
    `TeamIdentifier=${overrides.TeamIdentifier ?? "not set"}`,
    overrides.InfoPlist ?? "Info.plist entries=31",
    overrides.SealedResources ?? "Sealed Resources version=2 rules=13 files=287",
    overrides.InternalRequirements ?? "Internal requirements count=0 size=12",
    `CDHash=${overrides.CDHash ?? cdHash}`,
  ].join("\n");
}

function nestedSignature(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `Executable=${overrides.Executable ?? "/Applications/Acceptance.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"}`,
    `Identifier=${overrides.Identifier ?? "icu.enduragent.desktop.telegram-acceptance.helper"}`,
    `CDHash=${overrides.CDHash ?? cdHash}`,
    `Signature=${overrides.Signature ?? "adhoc"}`,
    `TeamIdentifier=${overrides.TeamIdentifier ?? "not set"}`,
    ...(overrides.Nested === undefined ? [] : [overrides.Nested]),
  ].join("\n");
}

function infoPlist() {
  return {
    CFBundleIdentifier: TELEGRAM_ACCEPTANCE_APP_ID,
    CFBundleName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    CFBundleDisplayName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    CFBundleExecutable: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  };
}

function manifest() {
  return {
    name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
    productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    [TELEGRAM_ACCEPTANCE_MARKER]: true,
    version,
    type: "module",
    main: "out/main/index.js",
  };
}

function productionMain(target = '"./index-DV6OlGhL.js"'): string {
  return `import { app } from "electron";
const TELEGRAM_ACCEPTANCE_QUIT_FRAME = '{"type":"enduragent-telegram-acceptance","command":"quit"}\\n';
function installTelegramAcceptanceQuitControl(input, quit) {
  let source = "";
  let valid = true;
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    if (!valid) return;
    source += chunk;
    if (source.length > TELEGRAM_ACCEPTANCE_QUIT_FRAME.length || !TELEGRAM_ACCEPTANCE_QUIT_FRAME.startsWith(source)) {
      valid = false;
    }
  });
  input.once("error", () => {
    valid = false;
  });
  input.once("end", () => {
    if (valid && source === TELEGRAM_ACCEPTANCE_QUIT_FRAME) quit();
  });
  input.resume();
}
function telegramAcceptanceStartupFailureDiagnostic(error) {
  let category = "unknown";
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      switch (error.code) {
        case "ERR_INVALID_PACKAGE_CONFIG":
        case "ERR_INVALID_PACKAGE_TARGET":
        case "ERR_MODULE_NOT_FOUND":
        case "ERR_PACKAGE_IMPORT_NOT_DEFINED":
        case "ERR_PACKAGE_PATH_NOT_EXPORTED":
        case "ERR_UNKNOWN_FILE_EXTENSION":
        case "ERR_UNSUPPORTED_DIR_IMPORT":
          category = "module-resolution";
      }
    }
  } catch {
  }
  return \`packaged Desktop production startup failed; category=${"${category}"}\`;
}
async function runTelegramAcceptanceBootstrap(input) {
  try {
    installTelegramAcceptanceQuitControl(input.input, input.quit);
    input.beforeImport();
    await input.importProduction();
  } catch (error) {
    try { input.report(telegramAcceptanceStartupFailureDiagnostic(error)); } catch {}
    try { input.exit(1); } catch {}
  }
}
const ACCEPTANCE_OS_LOGIN_MARKER_ENV = "ENDURAGENT_ACCEPTANCE_OS_LOGIN_LAUNCH";
const ACCEPTANCE_OS_LOGIN_MARKER_VALUE = "os-login";
function installSingleLoginLaunchObservation(app2, wasOpenedAtLogin) {
  const key = "getLoginItemSettings";
  const ownDescriptor = Object.getOwnPropertyDescriptor(app2, key);
  const original = app2.getLoginItemSettings;
  let pending = true;
  const restore = () => {
    if (ownDescriptor === void 0) {
      if (!Reflect.deleteProperty(app2, key)) {
        throw new TypeError("Telegram acceptance startup port could not be restored");
      }
      return;
    }
    Object.defineProperty(app2, key, ownDescriptor);
  };
  Object.defineProperty(app2, key, {
    configurable: true,
    writable: true,
    value(...args) {
      if (!pending) throw new TypeError("Telegram acceptance startup marker was reused");
      pending = false;
      restore();
      return { ...original.apply(app2, args), wasOpenedAtLogin };
    }
  });
}
function consumeAcceptanceStartupMarker(environment, app2) {
  const marker = environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  delete environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  if (marker === void 0) {
    installSingleLoginLaunchObservation(app2, false);
    return "manual";
  }
  if (marker !== ACCEPTANCE_OS_LOGIN_MARKER_VALUE) {
    throw new TypeError("Telegram acceptance startup marker is invalid");
  }
  installSingleLoginLaunchObservation(app2, true);
  return "os-login";
}
await runTelegramAcceptanceBootstrap({
  input: process.stdin,
  beforeImport: () => consumeAcceptanceStartupMarker(process.env, app),
  importProduction: () => import(${target}),
  quit: () => app.quit(),
  report: (diagnostic) => process.stderr.write(\`${"${diagnostic}"}\\n\`),
  exit: (code) => {
    process.exitCode = code;
    app.exit(code);
  },
});`;
}

function emptyPackagedHelper(source: string, name: string, nextDeclaration: string): string {
  const start = source.indexOf(`function ${name}(`);
  const body = source.indexOf("{", start);
  const end = source.indexOf(nextDeclaration, body);
  if (start < 0 || body < 0 || end < 0) throw new TypeError("test helper boundary is invalid");
  return `${source.slice(0, body + 1)}}\n${source.slice(end)}`;
}

function oauthProductionMain(): string {
  return productionMain()
    .replace(
      'import { app } from "electron";',
      'import { app, shell } from "electron";\nimport { installOAuthAcceptanceRoute } from "./oauth-acceptance-route-verified.js";\nimport "node:fs";\nimport "node:path";',
    )
    .replace(
      "beforeImport: () => consumeAcceptanceStartupMarker(process.env, app),",
      'beforeImport: () => { installOAuthAcceptanceRoute("main", shell); consumeAcceptanceStartupMarker(process.env, app); },',
    );
}

function beforePackagedBootstrap(source: string, mutation: string): string {
  const handoff = "await runTelegramAcceptanceBootstrap({";
  if (!source.includes(handoff)) throw new TypeError("test bootstrap boundary is invalid");
  return source.replace(handoff, `${mutation}\n${handoff}`);
}

describe("Telegram acceptance package", () => {
  it("forces ad-hoc signing in pull-request builds without certificate discovery", () => {
    const environment = {
      CSC_FOR_PULL_REQUEST: "false",
      CSC_IDENTITY_AUTO_DISCOVERY: "true",
    };

    configureTelegramAcceptanceSigningEnvironment(environment);

    expect(environment).toEqual({
      CSC_FOR_PULL_REQUEST: "true",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
  });

  it("derives a distinct ad-hoc-signed acceptance identity without mutating the canonical config", () => {
    const canonical = canonicalBuilder();
    const derived = createTelegramAcceptanceBuilderConfiguration(canonical) as {
      readonly appId: string;
      readonly productName: string;
      readonly extraMetadata: Record<string, unknown>;
      readonly directories: Record<string, unknown>;
      readonly files: readonly unknown[];
      readonly mac: Record<string, unknown>;
    };

    expect(derived).toMatchObject({
      appId: TELEGRAM_ACCEPTANCE_APP_ID,
      productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
      extraMetadata: {
        name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
        productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
        [TELEGRAM_ACCEPTANCE_MARKER]: true,
      },
      directories: { output: "dist/telegram-acceptance-package" },
      mac: {
        identity: "-",
        hardenedRuntime: false,
        entitlements: "build/entitlements.mac.plist",
        entitlementsInherit: "build/entitlements.mac.plist",
        target: [{ target: "dir", arch: ["arm64"] }],
      },
    });
    expect(derived.files[0]).toEqual({
      from: "dist/telegram-acceptance-build/out",
      to: "out",
      filter: ["**/*"],
    });
    expect(Object.keys(derived.extraMetadata).sort()).toEqual([
      TELEGRAM_ACCEPTANCE_MARKER,
      "name",
      "productName",
    ]);
    expect(canonical).toEqual(canonicalBuilder());
  });

  it("fails closed when the canonical runtime FileSet is ambiguous", () => {
    expect(() =>
      createTelegramAcceptanceBuilderConfiguration({
        ...canonicalBuilder(),
        files: ["package.json"],
      }),
    ).toThrow("canonical Desktop runtime FileSet is ambiguous");
  });

  it("requires an ad-hoc, teamless signature with bound metadata and sealed resources", () => {
    expect(verifyTelegramAcceptanceSignature(signature())).toBe(cdHash);
    for (const invalid of [
      signature({ Identifier: "icu.enduragent.desktop" }),
      signature({ Signature: "Developer ID Application: Production" }),
      signature({ TeamIdentifier: "ABCDE12345" }),
      signature({ InfoPlist: "Info.plist entries=0" }),
      signature({ SealedResources: "Sealed Resources version=2 rules=13 files=0" }),
      signature({ InternalRequirements: "Internal requirements count=0 size=0" }),
      signature({ CDHash: "not-a-cdhash" }),
      `${signature()}\nSignature=Developer ID Application: Production`,
      `${signature()}\nTeamIdentifier=not set`,
    ]) {
      expect(() => verifyTelegramAcceptanceSignature(invalid)).toThrow();
    }
  });

  it("requires every nested code object to be unambiguously ad-hoc and teamless", () => {
    expect(() => verifyTelegramAcceptanceNestedSignature(nestedSignature())).not.toThrow();
    for (const invalid of [
      nestedSignature({ Signature: "Developer ID Application: Production" }),
      nestedSignature({ TeamIdentifier: "ABCDE12345" }),
      nestedSignature({ CDHash: "not-a-cdhash" }),
      `${nestedSignature()}\nSignature=adhoc`,
      `${nestedSignature()}\nTeamIdentifier=not set`,
    ]) {
      expect(() => verifyTelegramAcceptanceNestedSignature(invalid)).toThrow(
        "Telegram acceptance nested signature is invalid",
      );
    }
  });

  it("accepts absent nested entitlements or only the allow-jit entitlement", () => {
    expect(() => verifyTelegramAcceptanceNestedEntitlements(undefined)).not.toThrow();
    expect(() =>
      verifyTelegramAcceptanceNestedEntitlements(TELEGRAM_ACCEPTANCE_ENTITLEMENTS),
    ).not.toThrow();
    for (const invalid of [
      null,
      {},
      { "com.apple.security.cs.allow-jit": false },
      {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
    ]) {
      expect(() => verifyTelegramAcceptanceNestedEntitlements(invalid)).toThrow(
        "Telegram acceptance nested entitlements are invalid",
      );
    }
  });

  it("enumerates only unique, relative nested code paths from one executable", () => {
    const description = [
      nestedSignature(),
      "Nested=Frameworks/Helper.app",
      "Nested=Frameworks/Electron Framework.framework",
    ].join("\n");
    expect(verifyTelegramAcceptanceNestedListing(description)).toEqual({
      executable:
        "/Applications/Acceptance.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      nested: ["Frameworks/Helper.app", "Frameworks/Electron Framework.framework"],
    });

    for (const nested of [
      "Nested=",
      "Nested=/tmp/escape",
      "Nested=../escape",
      "Nested=Frameworks/../escape",
      "Nested=Frameworks/./Helper.app",
      "Nested=Frameworks//Helper.app",
      "Nested=Frameworks\\Helper.app",
      "Nested=Frameworks/Helper.app\nNested=Frameworks/Helper.app",
    ]) {
      expect(() =>
        verifyTelegramAcceptanceNestedListing([nestedSignature(), nested].join("\n")),
      ).toThrow("Telegram acceptance nested code listing is invalid");
    }
    expect(() =>
      verifyTelegramAcceptanceNestedListing(
        `${nestedSignature()}\nExecutable=/Applications/Other.app/Contents/MacOS/Other`,
      ),
    ).toThrow("Telegram acceptance nested code listing is invalid");
  });

  it("selects one canonical nested target inside the application", () => {
    const application = "/Applications/Acceptance.app";
    const helper = `${application}/Contents/Frameworks/Helper.app`;
    expect(selectTelegramAcceptanceNestedTarget(application, [helper, helper])).toBe(helper);
    expect(() => selectTelegramAcceptanceNestedTarget(application, [])).toThrow(
      "Telegram acceptance nested code target is missing",
    );
    expect(() =>
      selectTelegramAcceptanceNestedTarget(application, [
        helper,
        `${application}/Contents/Frameworks/Other.framework`,
      ]),
    ).toThrow("Telegram acceptance nested code target is ambiguous");
    expect(() => selectTelegramAcceptanceNestedTarget(application, ["/tmp/escape"])).toThrow(
      "Telegram acceptance nested code target escapes the application",
    );
    expect(() =>
      selectTelegramAcceptanceNestedTarget(application, ["relative/Helper.app"]),
    ).toThrow("Telegram acceptance nested code resolution is invalid");
  });

  it("requires the exact acceptance Info.plist identity", () => {
    expect(() => verifyTelegramAcceptanceInfoPlist(infoPlist())).not.toThrow();
    for (const [field, value] of [
      ["CFBundleIdentifier", "icu.enduragent.desktop"],
      ["CFBundleName", "Enduragent"],
      ["CFBundleDisplayName", "Enduragent"],
      ["CFBundleExecutable", "Enduragent"],
    ] as const) {
      expect(() => verifyTelegramAcceptanceInfoPlist({ ...infoPlist(), [field]: value })).toThrow(
        "Telegram acceptance Info.plist identity is invalid",
      );
    }
  });

  it("requires the exact signed entitlement dictionary", () => {
    expect(() =>
      verifyTelegramAcceptanceEntitlements(TELEGRAM_ACCEPTANCE_ENTITLEMENTS),
    ).not.toThrow();
    for (const invalid of [
      {},
      { "com.apple.security.cs.allow-jit": false },
      {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
      { "com.apple.application-identifier": TELEGRAM_ACCEPTANCE_APP_ID },
    ]) {
      expect(() => verifyTelegramAcceptanceEntitlements(invalid)).toThrow(
        "Telegram acceptance signed entitlements are invalid",
      );
    }
  });

  it("binds the ad-hoc designated requirement to the verified code-directory hash", () => {
    const expected = `# designated => cdhash H"${cdHash}"`;
    expect(() => verifyTelegramAcceptanceDesignatedRequirement(expected, cdHash)).not.toThrow();
    expect(() =>
      verifyTelegramAcceptanceDesignatedRequirement(
        `\n  ${expected.replaceAll(" ", "  ")}\n`,
        cdHash,
      ),
    ).not.toThrow();
    for (const invalid of [
      `designated => cdhash H"${cdHash}"`,
      `# designated => cdhash H"1123456789abcdef0123456789abcdef01234567"`,
      `# designated => identifier "${TELEGRAM_ACCEPTANCE_APP_ID}"`,
      `${expected} and anchor apple`,
      `# designated => cdhash h"${cdHash}"`,
    ]) {
      expect(() => verifyTelegramAcceptanceDesignatedRequirement(invalid, cdHash)).toThrow(
        "Telegram acceptance designated requirement is invalid",
      );
    }
    expect(() => verifyTelegramAcceptanceDesignatedRequirement(expected, "not-a-cdhash")).toThrow(
      "Telegram acceptance code-directory hash is invalid",
    );
  });

  it("requires the exact acceptance ASAR manifest identity and marker", () => {
    expect(() => verifyTelegramAcceptanceManifest(manifest(), version)).not.toThrow();
    for (const invalid of [
      { ...manifest(), name: "@enduragent/desktop" },
      { ...manifest(), productName: "Enduragent" },
      { ...manifest(), [TELEGRAM_ACCEPTANCE_MARKER]: false },
      { ...manifest(), version: "0.0.2" },
      { ...manifest(), type: "commonjs" },
      { ...manifest(), main: "out/main/not-the-wrapper.js" },
    ]) {
      expect(() => verifyTelegramAcceptanceManifest(invalid, version)).toThrow(
        "Telegram acceptance ASAR manifest identity is invalid",
      );
    }
  });

  it("audits every exact runtime export in the packaged workspace dependency closure", () => {
    const rootManifest = {
      dependencies: {
        "@enduragent/alpha": "workspace:*",
        external: "1.0.0",
      },
    };
    const manifests: Record<string, unknown> = {
      "node_modules/@enduragent/alpha/package.json": {
        name: "@enduragent/alpha",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
            require: "./dist/index.cjs",
          },
          "./feature": "./dist/feature.js",
          "./generated/*": "./dist/generated/*.js",
        },
        dependencies: { "@enduragent/beta": "workspace:*" },
      },
      "node_modules/@enduragent/beta/package.json": {
        name: "@enduragent/beta",
        exports: { ".": "./dist/index.js" },
      },
    };
    const archiveEntries = [
      ...Object.keys(manifests),
      "node_modules/@enduragent/alpha/dist/index.js",
      "node_modules/@enduragent/alpha/dist/index.cjs",
      "node_modules/@enduragent/alpha/dist/feature.js",
      "node_modules/@enduragent/beta/dist/index.js",
    ].map((entry) => `/${entry}`);

    expect(
      verifyTelegramAcceptanceWorkspaceRuntime(
        rootManifest,
        archiveEntries,
        (path: string) => manifests[path],
      ),
    ).toEqual({
      packages: ["@enduragent/alpha", "@enduragent/beta"],
      exportTargets: [
        "node_modules/@enduragent/alpha/dist/feature.js",
        "node_modules/@enduragent/alpha/dist/index.cjs",
        "node_modules/@enduragent/alpha/dist/index.js",
        "node_modules/@enduragent/beta/dist/index.js",
      ],
    });
  });

  it("rejects a packaged workspace dependency with any missing exact runtime export", () => {
    const manifestPath = "node_modules/@enduragent/kernel-node/package.json";
    const packageManifest = {
      name: "@enduragent/kernel-node",
      exports: {
        "./sqlite": "./dist/sqlite.js",
        "./archive": "./dist/archive/index.js",
      },
    };

    expect(() =>
      verifyTelegramAcceptanceWorkspaceRuntime(
        { dependencies: { "@enduragent/kernel-node": "workspace:*" } },
        [`/${manifestPath}`, "/node_modules/@enduragent/kernel-node/dist/sqlite.js"],
        (path: string) => (path === manifestPath ? packageManifest : undefined),
      ),
    ).toThrow(
      "Telegram acceptance workspace export target is missing: @enduragent/kernel-node ./dist/archive/index.js",
    );
  });

  it("rejects missing or malformed packaged workspace package metadata", () => {
    const rootManifest = { dependencies: { "@enduragent/runtime": "workspace:*" } };
    expect(() =>
      verifyTelegramAcceptanceWorkspaceRuntime(rootManifest, [], () => undefined),
    ).toThrow("Telegram acceptance workspace package manifest is missing: @enduragent/runtime");
    expect(() =>
      verifyTelegramAcceptanceWorkspaceRuntime(
        rootManifest,
        ["/node_modules/@enduragent/runtime/package.json"],
        () => ({
          name: "@enduragent/runtime",
          exports: { ".": "../outside.js" },
        }),
      ),
    ).toThrow("Telegram acceptance workspace export target is invalid");
  });

  it("keeps the wrapped production main beside its runtime-relative dependencies", () => {
    expect(verifyTelegramAcceptanceMainEntry(productionMain())).toBe("out/main/index-DV6OlGhL.js");
    for (const invalid of [
      productionMain('"./chunks/index-DV6OlGhL.js"'),
      productionMain('"../main/index-DV6OlGhL.js"'),
      productionMain('"./index.js"'),
      productionMain("`./index-${suffix}.js`"),
      productionMain().replace("runTelegramAcceptanceBootstrap({", "arbitraryBootstrap({"),
      productionMain().replace("input: process.stdin,", "input: process.stdout,"),
      productionMain().replace("await input.importProduction();", "input.importProduction();"),
      productionMain().replace("input.exit(1);", "input.exit(0);"),
      productionMain().replace("importProduction: () =>", "productionImport: () =>"),
      productionMain().replace("process.exitCode = code;", "process.exitCode = 0;"),
      productionMain().replace("app.exit(code);", "app.exit(1);"),
      emptyPackagedHelper(
        productionMain(),
        "installTelegramAcceptanceQuitControl",
        "function telegramAcceptanceStartupFailureDiagnostic",
      ),
      emptyPackagedHelper(
        productionMain(),
        "telegramAcceptanceStartupFailureDiagnostic",
        "async function runTelegramAcceptanceBootstrap",
      ),
      emptyPackagedHelper(
        productionMain(),
        "installSingleLoginLaunchObservation",
        "function consumeAcceptanceStartupMarker",
      ),
      emptyPackagedHelper(
        productionMain(),
        "consumeAcceptanceStartupMarker",
        "await runTelegramAcceptanceBootstrap",
      ),
      `${productionMain()}\nprocess.stdout.write("after handoff");`,
      undefined,
    ]) {
      expect(() => verifyTelegramAcceptanceMainEntry(invalid)).toThrow();
    }
  });

  it("requires OAuth routing when verifying an OAuth acceptance package", () => {
    const readRoute = vi.fn(() => "");
    expect(() => verifyTelegramAcceptanceMainEntry(productionMain(), readRoute)).toThrow(
      "OAuth acceptance route import is required",
    );
    expect(readRoute).not.toHaveBeenCalled();
  });

  it("reads the exact route only after validating the routed bootstrap", () => {
    const readRoute = vi.fn(() => {
      throw new Error("route reader reached");
    });
    expect(() => verifyTelegramAcceptanceMainEntry(oauthProductionMain(), readRoute)).toThrow(
      "route reader reached",
    );
    expect(readRoute).toHaveBeenCalledExactlyOnceWith(
      "out/main/oauth-acceptance-route-verified.js",
    );
  });

  it("rejects omitted or replaced routing and changed bootstrap invocation before reading code", () => {
    for (const invalid of [
      oauthProductionMain().replace(
        'import { installOAuthAcceptanceRoute } from "./oauth-acceptance-route-verified.js";\n',
        "",
      ),
      oauthProductionMain().replace("./oauth-acceptance-route-verified.js", "./other-route.js"),
      oauthProductionMain().replace('installOAuthAcceptanceRoute("main", shell); ', ""),
      oauthProductionMain().replace(
        'installOAuthAcceptanceRoute("main", shell)',
        'installOAuthAcceptanceRoute("utility", shell)',
      ),
      oauthProductionMain().replace(
        'installOAuthAcceptanceRoute("main", shell)',
        'replacementRoute("main", shell)',
      ),
      oauthProductionMain().replace(
        "await runTelegramAcceptanceBootstrap({",
        "await replacementBootstrap({",
      ),
      oauthProductionMain().replace("input.beforeImport();", "input.importProduction();"),
    ]) {
      const readRoute = vi.fn(() => "");
      expect(() => verifyTelegramAcceptanceMainEntry(invalid, readRoute)).toThrow();
      expect(readRoute).not.toHaveBeenCalled();
    }
  });

  it("rejects modified transport content in the routed package", () => {
    const readRoute = vi.fn(() => "export function installOAuthAcceptanceRoute() {}");
    expect(() => verifyTelegramAcceptanceMainEntry(oauthProductionMain(), readRoute)).toThrow(
      "OAuth acceptance route does not match the reviewed transport",
    );
    expect(readRoute).toHaveBeenCalledExactlyOnceWith(
      "out/main/oauth-acceptance-route-verified.js",
    );
  });

  it("rejects writes to protected packaged helpers immediately before bootstrap", () => {
    for (const mutation of [
      "installTelegramAcceptanceQuitControl = () => {};",
      "installTelegramAcceptanceQuitControl = installTelegramAcceptanceQuitControl;",
      "telegramAcceptanceStartupFailureDiagnostic = telegramAcceptanceStartupFailureDiagnostic;",
      'ACCEPTANCE_OS_LOGIN_MARKER_VALUE += "-mutated";',
      "runTelegramAcceptanceBootstrap.prototype.apply = undefined;",
      "({ replacement: consumeAcceptanceStartupMarker } = replacements);",
      "[telegramAcceptanceStartupFailureDiagnostic] = replacements;",
      "TELEGRAM_ACCEPTANCE_QUIT_FRAME++;",
      "delete installSingleLoginLaunchObservation.prototype;",
      'Object.defineProperty(consumeAcceptanceStartupMarker, "call", { value: undefined });',
    ]) {
      expect(() =>
        verifyTelegramAcceptanceMainEntry(beforePackagedBootstrap(productionMain(), mutation)),
      ).toThrow("Telegram acceptance production helper binding is mutated");
    }
  });

  it("rejects extra top-level authority mutations immediately before bootstrap", () => {
    for (const mutation of [
      "app.quit = () => {};",
      "process.stdin.on = () => {};",
      'eval("installTelegramAcceptanceQuitControl = () => {}");',
    ]) {
      expect(() =>
        verifyTelegramAcceptanceMainEntry(beforePackagedBootstrap(productionMain(), mutation)),
      ).toThrow("Telegram acceptance production top-level layout is invalid");
    }
  });

  it("rejects non-exact bootstrap parameters and Electron import syntax", () => {
    for (const invalid of [
      productionMain().replace(
        "async function runTelegramAcceptanceBootstrap(input)",
        "async function* runTelegramAcceptanceBootstrap(input)",
      ),
      productionMain().replace(
        "async function runTelegramAcceptanceBootstrap(input)",
        "async function runTelegramAcceptanceBootstrap(...input)",
      ),
      productionMain().replace("exit: (code) => {", "exit: (...code) => {"),
      productionMain().replace(
        'import { app } from "electron";',
        'import { app } from "electron" with { type: "json" };',
      ),
    ]) {
      expect(() => verifyTelegramAcceptanceMainEntry(invalid)).toThrow();
    }
  });
});
