#!/usr/bin/env tsx

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAggregatePackageIds } from "../packages/cycling-coach/build/legal-artifacts.js";

const requiredFiles = [
  "package/dist/index.js",
  "package/dist/index.js.map",
  "package/dist/LICENSE",
  "package/dist/NOTICE.md",
  "package/dist/THIRD_PARTY_LICENSES.txt",
  "package/dist/bundled-model-catalog.json",
  "package/dist/workout-chart-font.otf",
  "package/dist/workout-chart-font.LICENSE.txt",
  "package/README.md",
  "package/package.json",
];

export function readTarGz(path: string): Map<string, Buffer> {
  const archive = gunzipSync(readFileSync(path));
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) {
      throw new Error(`Invalid tar entry size for ${fullName}`);
    }
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (type === "0" || type === "\0") {
      entries.set(fullName.replace(/^\.\//, ""), archive.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function requiredEntry(entries: Map<string, Buffer>, path: string): Buffer {
  const entry = entries.get(path);
  if (!entry) throw new Error(`Published package is missing ${path}`);
  return entry;
}

export function verifyTarEntries(entries: Map<string, Buffer>, repoRoot: string): void {
  for (const path of requiredFiles) requiredEntry(entries, path);

  const absoluteBuildPath =
    /\/(?:Users|home)\/[^/\s]+\/|\/(?:private\/)?(?:tmp|var\/folders)\/|\/(?:app|workspace)\/|[A-Za-z]:\\{1,2}(?:Users|workspace|a|agent|build)\\{1,2}/;
  const forwardSlashRepoRoot = repoRoot.replaceAll("\\", "/");
  const backslashRepoRoot = forwardSlashRepoRoot.replaceAll("/", "\\");
  const buildRootVariants = [
    repoRoot,
    forwardSlashRepoRoot,
    backslashRepoRoot,
    backslashRepoRoot.replaceAll("\\", "\\\\"),
  ];
  for (const [path, contents] of entries) {
    const text = contents.toString("utf8");
    if (
      absoluteBuildPath.test(path) ||
      absoluteBuildPath.test(text) ||
      buildRootVariants.some((buildRoot) => path.includes(buildRoot) || text.includes(buildRoot))
    ) {
      throw new Error(`Published package contains an absolute build path in ${path}`);
    }
  }

  const forbiddenPath = [...entries.keys()].find(
    (path) =>
      /(?:^|\/)metafile(?:-[^/]*)?\.json$/i.test(path) ||
      path.startsWith("package/build/") ||
      path.includes("/build/license-"),
  );
  if (forbiddenPath) {
    throw new Error(`Published package contains build-only path: ${forbiddenPath}`);
  }

  const distLicense = requiredEntry(entries, "package/dist/LICENSE");
  const distNotice = requiredEntry(entries, "package/dist/NOTICE.md");
  if (!distLicense.equals(readFileSync(resolve(repoRoot, "LICENSE")))) {
    throw new Error("Published dist/LICENSE differs from canonical root LICENSE");
  }
  if (!distNotice.equals(readFileSync(resolve(repoRoot, "NOTICE.md")))) {
    throw new Error("Published dist/NOTICE.md differs from canonical root NOTICE.md");
  }

  const aggregate = requiredEntry(entries, "package/dist/THIRD_PARTY_LICENSES.txt").toString(
    "utf8",
  );
  if (aggregate.trim().length === 0) {
    throw new Error("Published third-party aggregate is empty");
  }
  const ids = parseAggregatePackageIds(aggregate);
  if (ids.length === 0) {
    throw new Error("Published third-party aggregate has no package entries");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Published third-party aggregate has duplicate package entries");
  }
  const sortedIds = [...ids].sort();
  if (JSON.stringify(ids) !== JSON.stringify(sortedIds)) {
    throw new Error("Published third-party aggregate is not deterministically ordered");
  }
  if (aggregate.includes("\nLicense: Apache-2.0\n")) {
    const startMarker = "===== CANONICAL LICENSE: Apache-2.0 =====\n\n";
    const endMarker = "\n\n===== END CANONICAL LICENSE =====";
    const start = aggregate.indexOf(startMarker);
    const end = aggregate.indexOf(endMarker, start + startMarker.length);
    const canonicalText =
      start === -1 || end === -1 ? "" : aggregate.slice(start + startMarker.length, end);
    const pinnedText = readFileSync(
      resolve(repoRoot, "packages/cycling-coach/build/license-texts/Apache-2.0.txt"),
      "utf8",
    ).trimEnd();
    if (canonicalText !== pinnedText) {
      throw new Error("Published canonical Apache-2.0 text differs from the reviewed source");
    }
  }
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`Package: ${escaped}\\nLicense: [^\\n]+`).test(aggregate)) {
      throw new Error(`Malformed third-party aggregate entry for ${id}`);
    }
  }
}

export function verifyPublishedPackage(tarballPath: string, repoRoot: string): void {
  verifyTarEntries(readTarGz(tarballPath), repoRoot);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const tarballPath = args[0];
  if (!tarballPath || args.length !== 1) {
    throw new Error("usage: pnpm check:published-package -- <package.tgz>");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  verifyPublishedPackage(resolve(tarballPath), repoRoot);
  console.log(`Verified published package: ${tarballPath}`);
}
