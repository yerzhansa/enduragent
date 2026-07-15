import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertOnlyNodeBuiltinExternals,
  assertAggregateMatchesGraph,
  collectThirdPartyPackages,
  contributingThirdPartyPackageIds,
  generateLegalArtifacts,
  overrideFilename,
  renderAggregate,
  type BuildMetafile,
} from "../build/legal-artifacts.js";

interface Fixture {
  root: string;
  packageRoot: string;
  inputRoot: string;
  repoRoot: string;
  distDir: string;
  overridesDir: string;
  apacheLicensePath: string;
  metafilePath: string;
  inputs: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), "legal-artifacts-"));
  const repoRoot = resolve(root, "repo");
  const packageRoot = resolve(repoRoot, "packages/cycling-coach");
  const distDir = resolve(packageRoot, "dist");
  const overridesDir = resolve(packageRoot, "build/license-overrides");
  const apacheLicensePath = resolve(packageRoot, "build/license-texts/Apache-2.0.txt");
  const metafilePath = resolve(distDir, "metafile-esm.json");
  for (const directory of [distDir, overridesDir, resolve(apacheLicensePath, "..")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(resolve(repoRoot, "LICENSE"), "project license\n");
  writeFileSync(resolve(repoRoot, "NOTICE.md"), "project notice\n");
  writeFileSync(apacheLicensePath, "canonical apache license\n");
  return {
    root,
    packageRoot,
    inputRoot: packageRoot,
    repoRoot,
    distDir,
    overridesDir,
    apacheLicensePath,
    metafilePath,
    inputs: [],
  };
}

function addPackage(
  target: Fixture,
  name: string,
  version: string,
  license: string,
  files: Record<string, string> = { LICENSE: "complete license text" },
): string {
  const encoded = name.replace("/", "+");
  const packageRoot = name.startsWith("@")
    ? resolve(
        target.repoRoot,
        `node_modules/.pnpm/${encoded}@${version}_peer/node_modules`,
        ...name.split("/"),
      )
    : resolve(target.repoRoot, `node_modules/.pnpm/${encoded}@${version}/node_modules/${name}`);
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  writeFileSync(resolve(packageRoot, "package.json"), JSON.stringify({ name, version, license }));
  for (const [filename, text] of Object.entries(files)) {
    writeFileSync(resolve(packageRoot, filename), text);
  }
  const input = resolve(packageRoot, "dist/index.js");
  writeFileSync(input, "export {};\n");
  target.inputs.push(relative(target.packageRoot, input));
  return packageRoot;
}

function metafile(target: Fixture): BuildMetafile {
  return {
    outputs: {
      "dist/index.js": {
        inputs: Object.fromEntries(target.inputs.map((input) => [input, {}])),
      },
    },
  };
}

describe("legal artifact generation", () => {
  it("accepts built-in static and require imports", () => {
    const graph: BuildMetafile = {
      outputs: {
        "dist/index.js": {
          inputs: {},
          imports: [
            { path: "node:fs", kind: "import-statement", external: true },
            { path: "path", kind: "require-call", external: true },
            { path: "node:test", kind: "dynamic-import", external: true },
          ],
        },
      },
    };

    expect(assertOnlyNodeBuiltinExternals(graph)).toEqual([
      "node:fs (import-statement)",
      "node:test (dynamic-import)",
      "path (require-call)",
    ]);
  });

  it.each([
    ["encoding", "require-call"],
    ["unexpected-package", "import-statement"],
  ])("rejects external %s imports", (path, kind) => {
    const graph: BuildMetafile = {
      outputs: {
        "dist/index.js": {
          inputs: {},
          imports: [{ path, kind, external: true }],
        },
      },
    };

    expect(() => assertOnlyNodeBuiltinExternals(graph)).toThrow(`${path} (${kind})`);
  });

  it("accepts a bundle with no external imports", () => {
    expect(() =>
      assertOnlyNodeBuiltinExternals({ outputs: { "dist/index.js": { inputs: {} } } }),
    ).not.toThrow();
  });

  it("decodes scoped and unscoped pnpm roots, de-duplicates exact versions, and sorts", () => {
    const target = fixture();
    addPackage(target, "zeta", "1.0.0", "MIT", {
      LICENSE: "zeta license",
      NOTICE: "zeta notice",
    });
    addPackage(target, "@scope/alpha", "2.0.0", "ISC");
    addPackage(target, "zeta", "2.0.0", "BSD-2-Clause");
    target.inputs.push(target.inputs[0]);

    const packages = collectThirdPartyPackages(metafile(target), target);

    expect(packages.map((entry) => entry.id)).toEqual([
      "@scope/alpha@2.0.0",
      "zeta@1.0.0",
      "zeta@2.0.0",
    ]);
    expect(packages[1].noticeFiles).toEqual([{ name: "NOTICE", text: "zeta notice" }]);
    expect(contributingThirdPartyPackageIds(metafile(target), target.packageRoot)).toEqual([
      "@scope/alpha@2.0.0",
      "zeta@1.0.0",
      "zeta@2.0.0",
    ]);
  });

  it("fails closed when a third-party input has no resolvable package root", () => {
    const target = fixture();
    writeFileSync(
      resolve(target.repoRoot, "package.json"),
      JSON.stringify({ name: "workspace-root", version: "0.0.0", license: "MIT" }),
    );
    const input = resolve(target.repoRoot, "node_modules/orphan/index.js");
    mkdirSync(resolve(input, ".."), { recursive: true });
    writeFileSync(input, "export {};\n");
    target.inputs.push(relative(target.packageRoot, input));

    expect(() => contributingThirdPartyPackageIds(metafile(target), target.packageRoot)).toThrow(
      "Cannot resolve contributing third-party package root",
    );
    expect(() => collectThirdPartyPackages(metafile(target), target)).toThrow(
      "Cannot resolve contributing third-party package root",
    );
  });

  it.each(["Apache-2.0", "MIT", "BSD-2-Clause", "ISC"])(
    "accepts the reviewed %s expression",
    (license) => {
      const target = fixture();
      addPackage(target, "accepted", "1.0.0", license);
      expect(collectThirdPartyPackages(metafile(target), target)[0].license).toBe(license);
    },
  );

  it.each(["unknown", "GPL-3.0-only", "MIT OR Apache-2.0"])(
    "rejects the unreviewed %s expression even when text exists",
    (license) => {
      const target = fixture();
      addPackage(target, "rejected", "1.0.0", license);
      expect(() => collectThirdPartyPackages(metafile(target), target)).toThrow(
        `Unreviewed license expression for rejected@1.0.0: ${license}`,
      );
    },
  );

  it("does not let an exact-version override bypass license policy", () => {
    const target = fixture();
    addPackage(target, "rejected", "1.0.0", "GPL-3.0-only", {});
    writeFileSync(
      resolve(target.overridesDir, overrideFilename("rejected", "1.0.0")),
      "complete override text",
    );

    expect(() => collectThirdPartyPackages(metafile(target), target)).toThrow(
      "Unreviewed license expression for rejected@1.0.0: GPL-3.0-only",
    );
  });

  it("fails closed without license material and binds overrides to exact versions", () => {
    const target = fixture();
    addPackage(target, "missing", "1.0.1", "MIT", {});
    writeFileSync(
      resolve(target.overridesDir, overrideFilename("missing", "1.0.0")),
      "old reviewed text",
    );

    expect(() => collectThirdPartyPackages(metafile(target), target)).toThrow(
      "Missing license material for missing@1.0.1",
    );

    const exactName = overrideFilename("missing", "1.0.1");
    writeFileSync(resolve(target.overridesDir, exactName), "exact reviewed text");
    expect(collectThirdPartyPackages(metafile(target), target)[0].override).toEqual({
      name: exactName,
      text: "exact reviewed text",
    });
  });

  it("rejects an override when the package already supplies license material", () => {
    const target = fixture();
    addPackage(target, "complete", "1.0.0", "MIT");
    writeFileSync(
      resolve(target.overridesDir, overrideFilename("complete", "1.0.0")),
      "unnecessary override",
    );

    expect(() => collectThirdPartyPackages(metafile(target), target)).toThrow(
      "Exact-version override conflicts with discovered license material for complete@1.0.0",
    );
  });

  it("includes canonical Apache text once and retains a short package notice", () => {
    const target = fixture();
    addPackage(target, "apache-one", "1.0.0", "Apache-2.0", {
      LICENSE: "Copyright Example One\nShort Apache notice",
    });
    addPackage(target, "apache-two", "1.0.0", "Apache-2.0", {
      LICENSE: "Copyright Example Two\nShort Apache notice",
    });
    const aggregate = renderAggregate(
      collectThirdPartyPackages(metafile(target), target),
      "canonical apache license",
    );

    expect(aggregate.match(/canonical apache license/g)).toHaveLength(1);
    expect(aggregate).toContain("Copyright Example One");
    expect(aggregate).toContain("Copyright Example Two");
  });

  it("retains package attribution surrounding a canonical Apache license", () => {
    const target = fixture();
    addPackage(target, "apache-mixed", "1.0.0", "Apache-2.0", {
      LICENSE: "Copyright Example Before\ncanonical apache license\nPackage notice after",
    });
    const aggregate = renderAggregate(
      collectThirdPartyPackages(metafile(target), target),
      "canonical apache license",
    );

    expect(aggregate.match(/canonical apache license/g)).toHaveLength(1);
    expect(aggregate).toContain("Copyright Example Before");
    expect(aggregate).toContain("Package notice after");
  });

  it("retains attribution from the current Apache-licensed provider package", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const apacheText = readFileSync(
      resolve(repoRoot, "packages/cycling-coach/build/license-texts/Apache-2.0.txt"),
      "utf8",
    );
    const packageRoot = resolve(repoRoot, "packages/core/node_modules/@openrouter/ai-sdk-provider");
    const aggregate = renderAggregate(
      [
        {
          id: "@openrouter/ai-sdk-provider@2.9.1",
          name: "@openrouter/ai-sdk-provider",
          version: "2.9.1",
          license: "Apache-2.0",
          packageRoot,
          licenseFiles: [
            { name: "LICENSE", text: readFileSync(resolve(packageRoot, "LICENSE"), "utf8") },
          ],
          noticeFiles: [],
        },
      ],
      apacheText,
    );

    expect(aggregate).toContain("Copyright 2025 OpenRouter Inc,");
    expect(aggregate.match(/TERMS AND CONDITIONS FOR USE/g)).toHaveLength(1);
  });

  it("copies canonical bytes, proves graph equality, and deletes the metafile", async () => {
    const target = fixture();
    addPackage(target, "complete", "1.0.0", "MIT");
    writeFileSync(target.metafilePath, JSON.stringify(metafile(target)));

    await generateLegalArtifacts(target);

    expect(readFileSync(resolve(target.distDir, "LICENSE"))).toEqual(
      readFileSync(resolve(target.repoRoot, "LICENSE")),
    );
    expect(readFileSync(resolve(target.distDir, "NOTICE.md"))).toEqual(
      readFileSync(resolve(target.repoRoot, "NOTICE.md")),
    );
    expect(readFileSync(resolve(target.distDir, "THIRD_PARTY_LICENSES.txt"), "utf8")).toContain(
      "Package: complete@1.0.0",
    );
    expect(existsSync(target.metafilePath)).toBe(false);
  });

  it("rejects aggregate membership mismatches and duplicate entries", () => {
    expect(() => assertAggregateMatchesGraph(["a@1"], ["a@1", "b@1"])).toThrow(
      "does not match bundle graph",
    );
    expect(() => assertAggregateMatchesGraph(["a@1", "a@1"], ["a@1"])).toThrow(
      "does not match bundle graph",
    );
  });
});
