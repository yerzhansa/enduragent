import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RULES,
  runRulesAgainst,
  checkPrivatePackages,
  matchesEntry,
  packageRoot,
  main,
  type PackageDepRule,
} from "./check-package-deps.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "package-deps-lint-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function write(rel: string, contents: string): string {
  const p = join(tempDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, contents, "utf-8");
  return p;
}

function writeJson(rel: string, obj: unknown): string {
  return write(rel, JSON.stringify(obj, null, 2));
}

function ruleForDir(dir: string): PackageDepRule {
  const r = RULES.find((x) => x.dir === dir);
  if (!r) throw new Error(`no rule for ${dir}`);
  return r;
}

function violationsFor(rule: PackageDepRule): number {
  return runRulesAgainst(tempDir, [rule]).violations.length;
}

const r1 = ruleForDir("packages/kernel");
const r2 = ruleForDir("packages/kernel-node");
const rEngine = ruleForDir("packages/engine");
const rCore = ruleForDir("packages/core");
const r4 = ruleForDir("packages/sport-*");
const r5 = ruleForDir("packages/sync-*");
const rCoachCli = ruleForDir("packages/coach-cli");
const rCoachClient = ruleForDir("packages/coach-client");
const rRenderer = ruleForDir("apps/desktop-renderer");
const rDesktop = ruleForDir("apps/desktop");
const rCoach = ruleForDir("packages/coach");
const rBin = ruleForDir("packages/cycling-coach");

describe("relative workspace imports", () => {
  it.each([
    'import { value } from "../../engine/src/index.js";',
    'import "../../engine/src/index.js";',
    'export { value } from "../../engine/src/index.js";',
    'export * from "../../engine/src/index.js";',
    'export const value = import("../../engine/src/index.js");',
    'export const value = require("../../engine/src/index.js");',
  ])("rejects a forbidden relative edge: %s", (source) => {
    writeJson("packages/engine/package.json", { name: "@enduragent/engine", private: true });
    write("packages/engine/src/index.ts", "export const value = 1;");
    const file = write("packages/kernel/src/bad.ts", source);
    expect(runRulesAgainst(tempDir, [r1]).violations).toEqual([
      expect.objectContaining({ file, specifier: "../../engine/src/index.js", ruleId: "R1" }),
    ]);
    expect(main([tempDir])).toBe(1);
  });

  it("preserves same-package, shared-file, and allowed workspace imports", () => {
    writeJson("packages/kernel/package.json", { name: "@enduragent/kernel", private: true });
    write("packages/kernel/src/index.ts", "export const value = 1;");
    writeJson("packages/kernel-node/package.json", {
      name: "@enduragent/kernel-node",
      private: true,
    });
    write(
      "packages/kernel-node/src/ok.ts",
      [
        'import "./helper.js";',
        'import "../test/helper.js";',
        'import "../../../tools/helper.js";',
        'import "../../kernel/src/index.js";',
      ].join("\n"),
    );
    expect(violationsFor(r2)).toBe(0);
  });

  it("preserves transitional warnings for relative imports", () => {
    writeJson("packages/engine/package.json", { name: "@enduragent/engine", private: true });
    write("packages/core/src/shim.ts", 'export * from "../../engine/src/index.js";');
    const result = runRulesAgainst(tempDir, [rCore]);
    expect(result.violations).toHaveLength(0);
    expect(result.warnEdges).toEqual([{ dir: "packages/core", target: "@enduragent/engine" }]);
  });

  it("resolves imports across workspace groups and normalizes parent segments", () => {
    writeJson("packages/engine/package.json", { name: "@enduragent/engine", private: true });
    write(
      "apps/desktop-renderer/src/bad.tsx",
      'import "../../../packages/core/../engine/src/index.js";',
    );
    expect(violationsFor(rRenderer)).toBe(1);
  });

  it.each(["src/contracts/sport", "src/contracts/sport/index.js", "dist/contracts/sport/index.js"])(
    "maps declared export targets independently of their file name: %s",
    (target) => {
      writeJson("packages/engine/package.json", {
        name: "@enduragent/engine",
        private: true,
        exports: { "./sport": "./dist/contracts/sport/index.js" },
      });
      write("packages/sport-x/src/ok.ts", `export * from "../../engine/${target}";`);
      expect(violationsFor(r4)).toBe(0);
    },
  );

  it("does not infer an allowed sport export from a private file's name", () => {
    writeJson("packages/engine/package.json", {
      name: "@enduragent/engine",
      private: true,
      exports: { "./sport": "./dist/contracts/sport.js" },
    });
    write("packages/sport-x/src/bad.ts", 'export * from "../../engine/src/sport.js";');
    expect(violationsFor(r4)).toBe(1);
  });

  it.each(["src/sport.ts", "src/sport.js", "dist/sport.js"])(
    "allows the declared engine sport entry through %s",
    (target) => {
      writeJson("packages/engine/package.json", {
        name: "@enduragent/engine",
        private: true,
        exports: { "./sport": { types: "./dist/sport.d.ts", import: "./dist/sport.js" } },
      });
      write("packages/sport-x/src/ok.ts", `export * from "../../engine/${target}";`);
      expect(violationsFor(r4)).toBe(0);
    },
  );

  it.each([
    "src/index.js",
    "src/runtime.js",
    "src/sport-internal.js",
    "src/sport/private.js",
    "src/sport/index.js",
  ])("rejects engine imports outside its declared sport entry: %s", (target) => {
    writeJson("packages/engine/package.json", {
      name: "@enduragent/engine",
      private: true,
      exports: { "./sport": "./dist/sport.js" },
    });
    write("packages/sport-x/src/bad.ts", `export * from "../../engine/${target}";`);
    expect(violationsFor(r4)).toBe(1);
  });
});

describe("R1 kernel purity", () => {
  it("R1 flags a node: prefixed import", () => {
    write("packages/kernel/src/bad.ts", `import { readFileSync } from "node:fs";\n`);
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a bare Node builtin import", () => {
    write("packages/kernel/src/bad.ts", `import fs from "fs";\n`);
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a require() of a builtin", () => {
    write(
      "packages/kernel/src/bad.ts",
      `declare const require: (m: string) => unknown;\nconst fs = require("node:fs");\nexport const x = fs;\n`,
    );
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a dynamic import of a builtin", () => {
    write(
      "packages/kernel/src/bad.ts",
      `export async function f() {\n  return await import("node:path");\n}\n`,
    );
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a workspace import (kernel imports nothing)", () => {
    write(
      "packages/kernel/src/bad.ts",
      `import { z } from "@enduragent/core";\nexport const x = z;\n`,
    );
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags an @enduragent dependency in the manifest", () => {
    write("packages/kernel/src/clean.ts", `export const x = 1;\n`);
    writeJson("packages/kernel/package.json", {
      name: "@enduragent/kernel",
      private: true,
      dependencies: { "@enduragent/coach-contract": "workspace:*" },
    });
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 passes a clean kernel (zod + relative imports)", () => {
    write(
      "packages/kernel/src/clean.ts",
      `import { z } from "zod";\nimport { helper } from "./helper.js";\nexport const x = z ?? helper;\n`,
    );
    write("packages/kernel/src/helper.ts", `export const helper = 1;\n`);
    expect(violationsFor(r1)).toBe(0);
  });
});

describe("R2 kernel-node adapter", () => {
  it("R2 flags importing @enduragent/core", () => {
    write(
      "packages/kernel-node/src/bad.ts",
      `import { z } from "@enduragent/core";\nexport const x = z;\n`,
    );
    expect(violationsFor(r2)).toBe(1);
  });

  it("R2 passes importing @enduragent/kernel and node:fs (node allowed here)", () => {
    write(
      "packages/kernel-node/src/ok.ts",
      `import { KERNEL_STATUS } from "@enduragent/kernel";\nimport { readFileSync } from "node:fs";\nexport const x = KERNEL_STATUS ?? readFileSync;\n`,
    );
    expect(violationsFor(r2)).toBe(0);
  });

  it("R2 passes an exact declared public owning-package self-subpath", () => {
    writeJson("packages/kernel-node/package.json", {
      name: "@enduragent/kernel-node",
      private: true,
      exports: { "./home": "./dist/home/index.js" },
    });
    write(
      "packages/kernel-node/src/ok.ts",
      `import { resolveAthleteHome } from "@enduragent/kernel-node/home";\nexport const x = resolveAthleteHome;\n`,
    );
    expect(violationsFor(r2)).toBe(0);
  });

  it("R2 flags the owning-package root self-import", () => {
    writeJson("packages/kernel-node/package.json", {
      name: "@enduragent/kernel-node",
      private: true,
      exports: { "./home": "./dist/home/index.js" },
    });
    write(
      "packages/kernel-node/src/bad.ts",
      `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`,
    );
    expect(violationsFor(r2)).toBe(1);
  });

  it("R2 flags an undeclared owning-package self-subpath", () => {
    writeJson("packages/kernel-node/package.json", {
      name: "@enduragent/kernel-node",
      private: true,
      exports: { "./home": "./dist/home/index.js" },
    });
    write(
      "packages/kernel-node/src/bad.ts",
      `import { x } from "@enduragent/kernel-node/home/internal";\nexport const y = x;\n`,
    );
    expect(violationsFor(r2)).toBe(1);
  });
});

describe("R3 engine + core", () => {
  it("R3 flags the engine importing @enduragent/kernel-node", () => {
    write(
      "packages/engine/src/bad.ts",
      `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`,
    );
    expect(violationsFor(rEngine)).toBe(1);
  });

  it("R3 flags the engine importing @enduragent/core", () => {
    write(
      "packages/engine/src/bad.ts",
      `import { x } from "@enduragent/core";\nexport const y = x;\n`,
    );
    expect(violationsFor(rEngine)).toBe(1);
  });

  it("R3 passes the engine importing coach-contract + sport-cycling", () => {
    write(
      "packages/engine/src/ok.ts",
      `import { a } from "@enduragent/coach-contract";\nimport { b } from "@enduragent/sport-cycling";\nexport const y = a ?? b;\n`,
    );
    expect(violationsFor(rEngine)).toBe(0);
  });

  it("R3 passes core importing @enduragent/engine but surfaces the transitional WARN", () => {
    write(
      "packages/core/src/shim.ts",
      `import { e } from "@enduragent/engine";\nexport const y = e;\n`,
    );
    const result = runRulesAgainst(tempDir, [rCore]);
    expect(result.violations).toHaveLength(0);
    expect(result.warnEdges).toContainEqual({ dir: "packages/core", target: "@enduragent/engine" });
  });

  it("R3 flags core importing @enduragent/kernel-node", () => {
    write(
      "packages/core/src/bad.ts",
      `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`,
    );
    expect(violationsFor(rCore)).toBe(1);
  });

  it("R3 passes core importing @enduragent/kernel but surfaces the transitional WARN", () => {
    write(
      "packages/core/src/shim.ts",
      `import { k } from "@enduragent/kernel";\nexport const y = k;\n`,
    );
    const result = runRulesAgainst(tempDir, [rCore]);
    expect(result.violations).toHaveLength(0);
    expect(result.warnEdges).toEqual([{ dir: "packages/core", target: "@enduragent/kernel" }]);
  });
});

describe("R4 sport packages", () => {
  it("R4 flags a sport importing @enduragent/engine (root, not the subpath)", () => {
    write(
      "packages/sport-x/src/bad.ts",
      `import { e } from "@enduragent/engine";\nexport const y = e;\n`,
    );
    expect(violationsFor(r4)).toBe(1);
  });

  it("R4 passes an engine owner manifest with a sport-subpath source import", () => {
    writeJson("packages/sport-x/package.json", {
      name: "@enduragent/sport-x",
      private: true,
      dependencies: { "@enduragent/engine": "workspace:*" },
    });
    write(
      "packages/sport-x/src/ok.ts",
      `import { e } from "@enduragent/engine/sport";\nexport const y = e;\n`,
    );
    expect(violationsFor(r4)).toBe(0);
  });

  it("R4 flags a sport importing @enduragent/kernel-node (the R8 wall)", () => {
    write(
      "packages/sport-x/src/bad.ts",
      `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`,
    );
    expect(violationsFor(r4)).toBe(1);
  });

  it("R4 flags a sport importing @enduragent/core", () => {
    write(
      "packages/sport-x/src/bad.ts",
      `import { c } from "@enduragent/core";\nexport const y = c;\n`,
    );
    expect(violationsFor(r4)).toBe(1);
  });
});

describe("R5 sync packages", () => {
  it("R5 flags a sync package importing @enduragent/core", () => {
    write(
      "packages/sync-x/src/bad.ts",
      `import { c } from "@enduragent/core";\nexport const y = c;\n`,
    );
    expect(violationsFor(r5)).toBe(1);
  });

  it("R5 passes a sync package importing @enduragent/kernel", () => {
    write(
      "packages/sync-x/src/ok.ts",
      `import { k } from "@enduragent/kernel";\nexport const y = k;\n`,
    );
    expect(violationsFor(r5)).toBe(0);
  });
});

describe("R6 desktop renderer", () => {
  const uiUrl = (version = "0.1.0") =>
    `https://github.com/yerzhansa/enduragent-ui/releases/download/v${version}/enduragent-ui-${version}.tgz`;
  function uiLock(version = "0.1.0") {
    const url = uiUrl(version);
    return {
      importers: {
        "apps/desktop-renderer": {
          dependencies: { "@enduragent/ui": { specifier: url, version: `${url}(react@19.2.8)` } },
        },
      },
      packages: {
        [`@enduragent/ui@${url}`]: {
          version,
          resolution: { tarball: url, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
        },
      },
      snapshots: { [`@enduragent/ui@${url}(react@19.2.8)`]: {} },
    };
  }

  function installUi(version = "0.1.0") {
    writeJson("pnpm-lock.yaml", uiLock(version));
    writeJson("apps/desktop-renderer/node_modules/@enduragent/ui/package.json", {
      name: "@enduragent/ui",
      version,
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./tailwind.css": "./dist/tailwind.css",
        "./blocked": null,
      },
    });
  }

  it("allows an installed GitHub release artifact with matching lock integrity and declared exports", () => {
    installUi();
    writeJson("apps/desktop-renderer/package.json", {
      dependencies: { "@enduragent/ui": uiUrl() },
    });
    write(
      "apps/desktop-renderer/src/ui.tsx",
      'import { Button } from "@enduragent/ui"; import "@enduragent/ui/tailwind.css"; export { Button };',
    );
    expect(violationsFor(rRenderer)).toBe(0);
  });

  it.each(["0.0.1", "0.1.0", "0.2.0", "1.0.0", "1.10.0"])(
    "allows a stable SemVer release: %s",
    (version) => {
      installUi(version);
      writeJson("apps/desktop-renderer/package.json", {
        dependencies: { "@enduragent/ui": uiUrl(version) },
      });
      expect(violationsFor(rRenderer)).toBe(0);
    },
  );

  it.each([
    "workspace:*",
    "file:./ui.tgz",
    "link:../ui",
    "^0.1.0",
    "0.1.0",
    uiUrl("0.1.1"),
    uiUrl("0.0.0"),
    uiUrl("0.01.0"),
    uiUrl("0.1.0-0"),
    uiUrl("0.1.0-beta.1"),
    uiUrl("0.1.0+build"),
    uiUrl("1.0.01"),
    uiUrl("9007199254740992.0.0"),
    uiUrl().replace("github.com", "github.com.example.org"),
    uiUrl().replace("https:", "http:"),
    uiUrl().replace("yerzhansa/", "other/"),
    uiUrl().replace("download/v0.1.0", "latest/download"),
    `${uiUrl()}?download=1`,
    `${uiUrl()}\n`,
    ` ${uiUrl()}`,
  ])("rejects a non-exact or mismatched UI dependency: %s", (version) => {
    installUi();
    writeJson("apps/desktop-renderer/package.json", {
      dependencies: { "@enduragent/ui": version },
    });
    write("apps/desktop-renderer/src/ui.tsx", 'export { Button } from "@enduragent/ui";');
    expect(violationsFor(rRenderer)).toBe(2);
  });

  it.each(["src/button", "dist/index.js", "unknown", "blocked"])(
    "rejects an undeclared UI subpath: %s",
    (subpath) => {
      installUi();
      writeJson("apps/desktop-renderer/package.json", {
        dependencies: { "@enduragent/ui": uiUrl() },
      });
      write(
        "apps/desktop-renderer/src/ui.tsx",
        `export { Button } from "@enduragent/ui/${subpath}";`,
      );
      expect(violationsFor(rRenderer)).toBe(1);
    },
  );

  it.each(["()", "(react@19", "(react@19))", "(react@19)?download=1"])(
    "rejects a malformed release resolution suffix: %s",
    (suffix) => {
      installUi();
      writeJson("apps/desktop-renderer/package.json", {
        dependencies: { "@enduragent/ui": uiUrl() },
      });
      const lock = uiLock();
      const version = `${uiUrl()}${suffix}`;
      lock.importers["apps/desktop-renderer"].dependencies["@enduragent/ui"].version = version;
      lock.snapshots = { [`@enduragent/ui@${version}`]: {} };
      writeJson("pnpm-lock.yaml", lock);
      expect(violationsFor(rRenderer)).toBe(1);
    },
  );

  it("rejects missing installations and undeclared UI imports", () => {
    writeJson("apps/desktop-renderer/package.json", {
      dependencies: { "@enduragent/ui": uiUrl() },
    });
    expect(violationsFor(rRenderer)).toBe(1);
    installUi();
    writeJson("apps/desktop-renderer/package.json", {});
    write("apps/desktop-renderer/src/ui.tsx", 'export { Button } from "@enduragent/ui";');
    expect(violationsFor(rRenderer)).toBe(1);
  });

  it.each([
    "missing",
    "specifier",
    "version",
    "tarball",
    "integrity",
    "package-version",
    "snapshot",
  ])("rejects incomplete or inconsistent release lock data: %s", (field) => {
    installUi();
    writeJson("apps/desktop-renderer/package.json", {
      dependencies: { "@enduragent/ui": uiUrl() },
    });
    const lock = uiLock();
    const dependency = lock.importers["apps/desktop-renderer"].dependencies["@enduragent/ui"];
    const entry = lock.packages[`@enduragent/ui@${uiUrl()}`]!;
    if (field === "specifier") dependency.specifier = uiUrl("0.1.1");
    if (field === "version") dependency.version = uiUrl("0.1.1");
    if (field === "tarball") entry.resolution.tarball = uiUrl("0.1.1");
    if (field === "integrity") entry.resolution.integrity = "sha512-invalid";
    if (field === "package-version") entry.version = "0.1.1";
    if (field === "snapshot") lock.snapshots = {};
    writeJson("pnpm-lock.yaml", field === "missing" ? {} : lock);
    expect(violationsFor(rRenderer)).toBe(1);
  });

  it("R6 flags the renderer importing @enduragent/engine", () => {
    write(
      "apps/desktop-renderer/src/bad.ts",
      `import { e } from "@enduragent/engine";\nexport const y = e;\n`,
    );
    expect(violationsFor(rRenderer)).toBe(1);
  });

  it("R6 passes the renderer importing @enduragent/coach-contract", () => {
    write(
      "apps/desktop-renderer/src/ok.ts",
      `import { a } from "@enduragent/coach-contract";\nexport const y = a;\n`,
    );
    expect(violationsFor(rRenderer)).toBe(0);
  });

  it("R6 passes coach-client and rejects Node and external imports", () => {
    write(
      "apps/desktop-renderer/src/client.ts",
      `import { connectCoachClient } from "@enduragent/coach-client";\nexport const client = connectCoachClient;\n`,
    );
    expect(violationsFor(rRenderer)).toBe(0);
    write(
      "apps/desktop-renderer/src/node.ts",
      `import fs from "node:fs";\nexport const value = fs;\n`,
    );
    write("apps/desktop-renderer/src/external.ts", `import value from "zod";\nexport { value };\n`);
    expect(violationsFor(rRenderer)).toBe(2);
  });

  it.each(["@base-ui/react", "lucide-react"])(
    "R6 passes the retained renderer dependency: %s",
    (dependency) => {
      write("apps/desktop-renderer/src/ok.ts", `import "${dependency}";`);
      writeJson("apps/desktop-renderer/package.json", {
        name: "@enduragent/desktop-renderer",
        private: true,
        dependencies: { [dependency]: "1.0.0" },
      });
      expect(violationsFor(rRenderer)).toBe(0);
    },
  );

  it.each([
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "tw-animate-css",
    "@fontsource-variable/geist-mono",
    "@fontsource-variable/inter",
  ])("R6 rejects a direct renderer dependency owned by shared UI: %s", (dependency) => {
    writeJson("apps/desktop-renderer/package.json", {
      name: "@enduragent/desktop-renderer",
      private: true,
      dependencies: { [dependency]: "1.0.0" },
    });
    expect(violationsFor(rRenderer)).toBe(1);
    write("apps/desktop-renderer/src/bad.ts", `import "${dependency}";`);
    expect(violationsFor(rRenderer)).toBe(2);
  });
});

describe("R8 desktop app", () => {
  it("allows coach, coach-client, coach-contract, and core workspace edges", () => {
    write(
      "apps/desktop/src/ok.ts",
      `import { run } from "@enduragent/coach";\nimport { connectCoachClient } from "@enduragent/coach-client";\nimport { PROTOCOL_VERSION } from "@enduragent/coach-contract";\nimport { loginCodex } from "@enduragent/core";\nexport const value = [run, connectCoachClient, PROTOCOL_VERSION, loginCodex];\n`,
    );
    expect(violationsFor(rDesktop)).toBe(0);
    for (const [index, dependency] of [
      "@enduragent/engine",
      "@enduragent/kernel",
      "@enduragent/kernel-node",
      "@enduragent/sport-cycling",
      "@enduragent/sync-intervals",
    ].entries()) {
      write(
        `apps/desktop/src/bad-${index}.ts`,
        `import value from "${dependency}";\nexport { value };\n`,
      );
    }
    expect(violationsFor(rDesktop)).toBe(5);
  });
});

describe("R6 coach client", () => {
  it("allows only globals, relative modules, and the contract in source and runtime manifest", () => {
    write(
      "packages/coach-client/src/ok.ts",
      `import type { CoachEngine } from "@enduragent/coach-contract";\nimport { local } from "./local.js";\nexport const socket: WebSocket | null = null;\nexport const signal: AbortSignal | null = null;\nexport const timer = setTimeout;\nexport const value: CoachEngine | null = local;\n`,
    );
    write("packages/coach-client/src/local.ts", `export const local = null;\n`);
    writeJson("packages/coach-client/package.json", {
      name: "@enduragent/coach-client",
      private: true,
      dependencies: { "@enduragent/coach-contract": "workspace:*" },
    });
    expect(violationsFor(rCoachClient)).toBe(0);
  });

  it.each([
    [`import value from "ws";\nexport { value };\n`, "ws"],
    [
      `import type { Config } from 'other-external';\nexport const value: Config | null = null;\n`,
      "other-external",
    ],
    [`import 'ws';\n`, "ws"],
    [`export { value } from 'other-external';\n`, "other-external"],
    [`export const value = import("ws");\n`, "ws"],
    [
      `declare const require: (name: string) => unknown;\nexport const value = require('other-external');\n`,
      "other-external",
    ],
    [`import { readFileSync } from "node:fs";\nexport { readFileSync };\n`, "node:fs"],
    [`import fs from 'fs';\nexport { fs };\n`, "fs"],
  ])("rejects closed source import form for %s", (source, specifier) => {
    write("packages/coach-client/src/bad.ts", source);
    writeJson("packages/coach-client/package.json", {
      name: "@enduragent/coach-client",
      private: true,
    });
    const result = runRulesAgainst(tempDir, [rCoachClient]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.specifier).toBe(specifier);
  });

  it("rejects an external runtime manifest dependency", () => {
    write("packages/coach-client/src/ok.ts", `export const value = 1;\n`);
    writeJson("packages/coach-client/package.json", {
      name: "@enduragent/coach-client",
      private: true,
      dependencies: {
        "@enduragent/coach-contract": "workspace:*",
        ws: "^8.20.0",
      },
    });
    const result = runRulesAgainst(tempDir, [rCoachClient]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.specifier).toBe("ws");
  });
});

describe("R6 coach CLI", () => {
  it("allows contract and client while rejecting engine, kernel, and coach", () => {
    write(
      "packages/coach-cli/src/ok.ts",
      `import { contract } from "@enduragent/coach-contract";\nimport { client } from "@enduragent/coach-client";\nexport const value = contract ?? client;\n`,
    );
    writeJson("packages/coach-cli/package.json", {
      name: "@enduragent/coach-cli",
      private: true,
      dependencies: {
        "@enduragent/coach-contract": "workspace:*",
        "@enduragent/coach-client": "workspace:*",
      },
    });
    expect(violationsFor(rCoachCli)).toBe(0);

    for (const specifier of ["@enduragent/engine", "@enduragent/kernel", "@enduragent/coach"]) {
      write(
        "packages/coach-cli/src/bad.ts",
        `import value from "${specifier}";\nexport { value };\n`,
      );
      expect(
        runRulesAgainst(tempDir, [rCoachCli]).violations.some(
          (violation) => violation.specifier === specifier,
        ),
      ).toBe(true);
    }
  });
});

describe("R7 private-package check", () => {
  it("R7 flags an @enduragent package without private:true", () => {
    writeJson("packages/leaky/package.json", { name: "@enduragent/leaky" });
    expect(checkPrivatePackages(tempDir)).toHaveLength(1);
  });

  it("R7 passes an @enduragent package with private:true", () => {
    writeJson("packages/tight/package.json", { name: "@enduragent/tight", private: true });
    expect(checkPrivatePackages(tempDir)).toHaveLength(0);
  });
});

describe("R8 composition root", () => {
  it("R8 passes the composition root importing kernel-node + engine + sync + sport (the meet is legal here)", () => {
    write(
      "packages/coach/src/ok.ts",
      `import { a } from "@enduragent/kernel-node";\nimport { b } from "@enduragent/engine";\nimport { c } from "@enduragent/sync-intervals-icu";\nimport { d } from "@enduragent/sport-cycling";\nexport const y = a ?? b ?? c ?? d;\n`,
    );
    expect(violationsFor(rCoach)).toBe(0);
  });
});

describe("R-BIN legacy binaries", () => {
  it("R-BIN passes importing @enduragent/core + @enduragent/sport-cycling", () => {
    write(
      "packages/cycling-coach/src/ok.ts",
      `import { c } from "@enduragent/core";\nimport { s } from "@enduragent/sport-cycling";\nexport const y = c ?? s;\n`,
    );
    expect(violationsFor(rBin)).toBe(0);
  });

  it("R-BIN flags importing @enduragent/kernel-node (the new graph is walled off)", () => {
    write(
      "packages/cycling-coach/src/bad.ts",
      `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`,
    );
    expect(violationsFor(rBin)).toBe(1);
  });

  it("R-BIN flags importing @enduragent/engine", () => {
    write(
      "packages/cycling-coach/src/bad.ts",
      `import { e } from "@enduragent/engine";\nexport const y = e;\n`,
    );
    expect(violationsFor(rBin)).toBe(1);
  });
});

describe("skip-file directive", () => {
  it("R1 skips a violating kernel file carrying the skip marker", () => {
    write(
      "packages/kernel/src/skipped.ts",
      `// package-deps-lint:skip-file\nimport { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
    );
    expect(violationsFor(r1)).toBe(0);
  });
});

describe("matchers", () => {
  it("root entries allow subpaths; subpath entries never allow the root", () => {
    expect(matchesEntry("@enduragent/kernel", "@enduragent/kernel")).toBe(true);
    expect(matchesEntry("@enduragent/kernel/foo", "@enduragent/kernel")).toBe(true);
    expect(matchesEntry("@enduragent/engine", "@enduragent/engine/sport")).toBe(false);
    expect(matchesEntry("@enduragent/engine/sport", "@enduragent/engine/sport")).toBe(true);
    expect(matchesEntry("@enduragent/sport-cycling/migrate", "@enduragent/sport-*")).toBe(true);
    expect(matchesEntry("@enduragent/sports-foo", "@enduragent/sport-*")).toBe(false);
  });

  it("packageRoot collapses a subpath to the @enduragent/<name> root", () => {
    expect(packageRoot("@enduragent/sport-cycling/migrate")).toBe("@enduragent/sport-cycling");
    expect(packageRoot("@enduragent/core")).toBe("@enduragent/core");
  });
});

describe("real repository", () => {
  it("the committed workspace is clean", { timeout: 15_000 }, () => {
    expect(main([])).toBe(0);
  });

  it("surfaces exactly the remaining transitional edges", { timeout: 15_000 }, () => {
    const result = runRulesAgainst(".", RULES);
    const edges = result.warnEdges.map((e) => `${e.dir} -> ${e.target}`);
    expect(edges).toEqual([
      "packages/coach -> @enduragent/core",
      "packages/core -> @enduragent/engine",
      "packages/core -> @enduragent/kernel",
    ]);
    expect(result.warnEdges.filter((edge) => edge.dir.startsWith("packages/sport-"))).toEqual([]);
  });

  it("activates engine without making end-state discovery vacuous", { timeout: 15_000 }, () => {
    const result = runRulesAgainst(".", RULES);
    expect(result.notPresent).not.toContain("packages/engine");
    expect(result.notPresent).not.toContain("packages/coach-client");
    expect(result.notPresent).not.toContain("packages/sync-*");
    expect(result.scannedFileCount).toBeGreaterThan(0);
  });
});
