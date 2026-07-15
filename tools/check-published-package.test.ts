import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertOnlyCliGloballyInstalled,
  extractPackage,
  verifyTarEntries,
} from "./check-published-package.js";

function validFixture(): { entries: Map<string, Buffer>; repoRoot: string } {
  const repoRoot = mkdtempSync(resolve(tmpdir(), "packed-package-"));
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(resolve(repoRoot, "LICENSE"), "project license\n");
  writeFileSync(resolve(repoRoot, "NOTICE.md"), "project notice\n");
  const aggregate = [
    "THIRD-PARTY LICENSES AND NOTICES",
    "Generated from the exact inputs contributing to dist/index.js.",
    "",
    "----- PACKAGE -----",
    "Package: alpha@1.0.0",
    "License: MIT",
    "",
    "License text: LICENSE",
    "",
    "complete text",
    "",
    "----- END PACKAGE -----",
    "",
    "----- PACKAGE -----",
    "Package: zeta@2.0.0",
    "License: ISC",
    "",
    "License text: LICENSE",
    "",
    "complete text",
    "",
    "----- END PACKAGE -----",
    "",
  ].join("\n");
  return {
    repoRoot,
    entries: new Map(
      Object.entries({
        "package/dist/index.js": "bundle",
        "package/dist/index.js.map": "map",
        "package/dist/LICENSE": "project license\n",
        "package/dist/NOTICE.md": "project notice\n",
        "package/dist/THIRD_PARTY_LICENSES.txt": aggregate,
        "package/README.md": "readme",
        "package/package.json": JSON.stringify({
          name: "cycling-coach",
          version: "1.0.0",
          bin: { "cycling-coach": "dist/index.js" },
        }),
      }).map(([path, contents]) => [path, Buffer.from(contents)]),
    ),
  };
}

describe("published package verifier", () => {
  it("accepts complete, byte-identical, ordered legal artifacts", () => {
    const target = validFixture();
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).not.toThrow();
  });

  it("rejects missing legal artifacts and noncanonical bytes", () => {
    const missing = validFixture();
    missing.entries.delete("package/dist/NOTICE.md");
    expect(() => verifyTarEntries(missing.entries, missing.repoRoot)).toThrow(
      "missing package/dist/NOTICE.md",
    );

    const changed = validFixture();
    changed.entries.set("package/dist/LICENSE", Buffer.from("changed"));
    expect(() => verifyTarEntries(changed.entries, changed.repoRoot)).toThrow(
      "differs from canonical root LICENSE",
    );
  });

  it("rejects build paths, absolute paths, duplicates, and unstable ordering", () => {
    const buildPath = validFixture();
    buildPath.entries.set("package/dist/metafile-esm.json", Buffer.from("{}"));
    expect(() => verifyTarEntries(buildPath.entries, buildPath.repoRoot)).toThrow(
      "build-only path",
    );

    const absolute = validFixture();
    const aggregatePath = "package/dist/THIRD_PARTY_LICENSES.txt";
    absolute.entries.set(
      aggregatePath,
      Buffer.concat([absolute.entries.get(aggregatePath)!, Buffer.from("/Users/build/input")]),
    );
    expect(() => verifyTarEntries(absolute.entries, absolute.repoRoot)).toThrow(
      "absolute build path in package/dist/THIRD_PARTY_LICENSES.txt",
    );

    const duplicate = validFixture();
    const aggregate = duplicate.entries.get(aggregatePath)!.toString("utf8");
    duplicate.entries.set(
      aggregatePath,
      Buffer.from(
        `${aggregate}----- PACKAGE -----\nPackage: alpha@1.0.0\nLicense: MIT\n\nLicense text: LICENSE\n\ncomplete text\n\n----- END PACKAGE -----\n`,
      ),
    );
    expect(() => verifyTarEntries(duplicate.entries, duplicate.repoRoot)).toThrow(
      "duplicate package entries",
    );

    const unstable = validFixture();
    unstable.entries.set(
      aggregatePath,
      Buffer.from(
        aggregate
          .replace("Package: alpha@1.0.0", "Package: temporary@1.0.0")
          .replace("Package: zeta@2.0.0", "Package: alpha@1.0.0")
          .replace("Package: temporary@1.0.0", "Package: zeta@2.0.0"),
      ),
    );
    expect(() => verifyTarEntries(unstable.entries, unstable.repoRoot)).toThrow(
      "not deterministically ordered",
    );
  });

  it("rejects bundled node_modules paths", () => {
    const target = validFixture();
    target.entries.set("package/node_modules/unexpected/index.js", Buffer.from("export {};"));
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).toThrow("build-only path");
  });

  it.each(["package/../../escape", "package/D:\\escape", "package/\\\\server\\share\\escape"])(
    "rejects unsafe extraction path %s",
    (path) => {
      const destination = mkdtempSync(resolve(tmpdir(), "packed-package-extract-"));
      try {
        expect(() => extractPackage(new Map([[path, Buffer.from("escape")]]), destination)).toThrow(
          "Unsafe tar entry path",
        );
      } finally {
        rmSync(destination, { recursive: true, force: true });
      }
    },
  );

  it.each(["dependencies", "optionalDependencies", "peerDependencies"])(
    "rejects a packed %s field even when empty",
    (field) => {
      const target = validFixture();
      const manifest = JSON.parse(
        target.entries.get("package/package.json")!.toString("utf8"),
      ) as Record<string, unknown>;
      manifest[field] = {};
      target.entries.set("package/package.json", Buffer.from(JSON.stringify(manifest)));

      expect(() => verifyTarEntries(target.entries, target.repoRoot)).toThrow(
        `runtime field: ${field}`,
      );
    },
  );

  it("accepts only one dependency-free global CLI package", () => {
    expect(
      assertOnlyCliGloballyInstalled({ dependencies: { "cycling-coach": {} } }, "cycling-coach"),
    ).toBe(1);
    expect(() =>
      assertOnlyCliGloballyInstalled(
        { dependencies: { "cycling-coach": {}, encoding: {} } },
        "cycling-coach",
      ),
    ).toThrow("unexpected packages");
    expect(() =>
      assertOnlyCliGloballyInstalled(
        { dependencies: { "cycling-coach": { dependencies: { yaml: {} } } } },
        "cycling-coach",
      ),
    ).toThrow("runtime dependencies");
  });

  it("rejects build paths in runtime artifacts and incomplete aggregate entries", () => {
    const runtimePath = validFixture();
    runtimePath.entries.set(
      "package/dist/index.js.map",
      Buffer.from('{"sources":["../../../../Users/build/project/source.ts"]}'),
    );
    expect(() => verifyTarEntries(runtimePath.entries, runtimePath.repoRoot)).toThrow(
      "absolute build path in package/dist/index.js.map",
    );

    const incomplete = validFixture();
    const aggregatePath = "package/dist/THIRD_PARTY_LICENSES.txt";
    incomplete.entries.set(
      aggregatePath,
      Buffer.from(
        incomplete.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace("License text: LICENSE\n\ncomplete text\n\n----- END PACKAGE -----", ""),
      ),
    );
    expect(() => verifyTarEntries(incomplete.entries, incomplete.repoRoot)).toThrow(
      "nested third-party package entry",
    );
  });

  it("allows absolute path examples in third-party source content", () => {
    const target = validFixture();
    target.entries.set(
      "package/dist/index.js.map",
      Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ["../../../node_modules/example/index.js"],
          sourcesContent: ["const example = '/tmp/example.jpg';"],
        }),
      ),
    );
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).not.toThrow();
  });

  it.each([
    "/home/runner/work/project/source.ts",
    "/tmp/project/source.ts",
    "/private/tmp/project/source.ts",
    "/var/folders/cache/project/source.ts",
    "/workspace/project/source.ts",
    "/app/project/source.ts",
    "C:\\Users\\runner\\work\\project\\source.ts",
    "D:\\a\\project\\source.ts",
  ])("rejects the build-root sentinel %s", (sentinel) => {
    const target = validFixture();
    target.entries.set(
      "package/dist/index.js",
      Buffer.from(`const source = ${JSON.stringify(sentinel)};`),
    );
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).toThrow(
      "absolute build path in package/dist/index.js",
    );
  });

  it("rejects the exact checkout root in generated artifacts", () => {
    const target = validFixture();
    target.entries.set(
      "package/dist/index.js.map",
      Buffer.from(JSON.stringify({ sources: [`${target.repoRoot}/source.ts`] })),
    );
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).toThrow(
      "absolute build path in package/dist/index.js.map",
    );

    const windowsTarget = validFixture();
    windowsTarget.entries.set(
      "package/dist/index.js.map",
      Buffer.from(JSON.stringify({ sources: ["D:/custom-checkout/project/source.ts"] })),
    );
    expect(() => verifyTarEntries(windowsTarget.entries, "D:\\custom-checkout\\project")).toThrow(
      "absolute build path in package/dist/index.js.map",
    );
  });

  it("rejects malformed entry boundaries, fields, and license policy", () => {
    const aggregatePath = "package/dist/THIRD_PARTY_LICENSES.txt";

    const unterminated = validFixture();
    unterminated.entries.set(
      aggregatePath,
      Buffer.from(
        unterminated.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace("----- END PACKAGE -----", ""),
      ),
    );
    expect(() => verifyTarEntries(unterminated.entries, unterminated.repoRoot)).toThrow(
      "nested third-party package entry",
    );

    const unknownLicense = validFixture();
    unknownLicense.entries.set(
      aggregatePath,
      Buffer.from(
        unknownLicense.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace("License: MIT", "License: GPL-3.0-only"),
      ),
    );
    expect(() => verifyTarEntries(unknownLicense.entries, unknownLicense.repoRoot)).toThrow(
      "Unreviewed license expression",
    );

    const duplicateField = validFixture();
    duplicateField.entries.set(
      aggregatePath,
      Buffer.from(
        duplicateField.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace("License text: LICENSE", "License: MIT\n\nLicense text: LICENSE"),
      ),
    );
    expect(() => verifyTarEntries(duplicateField.entries, duplicateField.repoRoot)).toThrow(
      "Duplicate package field",
    );

    const missingText = validFixture();
    missingText.entries.set(
      aggregatePath,
      Buffer.from(
        missingText.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace("License text: LICENSE\n\ncomplete text", "License text: LICENSE"),
      ),
    );
    expect(() => verifyTarEntries(missingText.entries, missingText.repoRoot)).toThrow(
      "Missing legal material",
    );

    const borrowedNotice = validFixture();
    borrowedNotice.entries.set(
      aggregatePath,
      Buffer.from(
        borrowedNotice.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace(
            "License text: LICENSE\n\ncomplete text",
            "License text: LICENSE\n\nNotice: NOTICE\n\nnotice text",
          ),
      ),
    );
    expect(() => verifyTarEntries(borrowedNotice.entries, borrowedNotice.repoRoot)).toThrow(
      "Missing legal material",
    );

    const wrongSentinel = validFixture();
    wrongSentinel.entries.set(
      aggregatePath,
      Buffer.from(
        wrongSentinel.entries
          .get(aggregatePath)!
          .toString("utf8")
          .replace(
            "License text: LICENSE\n\ncomplete text",
            "License text: canonical Apache-2.0 text above",
          ),
      ),
    );
    expect(() => verifyTarEntries(wrongSentinel.entries, wrongSentinel.repoRoot)).toThrow(
      "Missing legal material",
    );
  });

  it("requires the packed canonical Apache text to match the reviewed source", () => {
    const target = validFixture();
    const pinnedPath = resolve(
      target.repoRoot,
      "packages/cycling-coach/build/license-texts/Apache-2.0.txt",
    );
    mkdirSync(resolve(pinnedPath, ".."), { recursive: true });
    writeFileSync(pinnedPath, "reviewed apache text\n");
    const apacheAggregate = [
      "THIRD-PARTY LICENSES AND NOTICES",
      "Generated from the exact inputs contributing to dist/index.js.",
      "",
      "===== CANONICAL LICENSE: Apache-2.0 =====",
      "",
      "reviewed apache text",
      "",
      "===== END CANONICAL LICENSE =====",
      "",
      "----- PACKAGE -----",
      "Package: apache-package@1.0.0",
      "License: Apache-2.0",
      "",
      "License text: canonical Apache-2.0 text above",
      "",
      "----- END PACKAGE -----",
      "",
    ].join("\n");
    target.entries.set("package/dist/THIRD_PARTY_LICENSES.txt", Buffer.from(apacheAggregate));
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).not.toThrow();

    target.entries.set(
      "package/dist/THIRD_PARTY_LICENSES.txt",
      Buffer.from(apacheAggregate.replace("reviewed apache text", "different apache text")),
    );
    expect(() => verifyTarEntries(target.entries, target.repoRoot)).toThrow(
      "differs from the reviewed source",
    );
  });
});
