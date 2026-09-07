import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDirectories = [
  "apps/desktop/",
  "apps/desktop-renderer/",
  "tools/ui-verification/",
  "packages/coach/",
  "packages/coach-cli/",
  "packages/coach-client/",
  "packages/coach-contract/",
  "packages/core/",
  "packages/engine/",
  "packages/kernel/",
  "packages/kernel-node/",
  "packages/sport-cycling/",
  "packages/sync-intervals-icu/",
];

export function requiresNative(path: string): boolean {
  if (nativeDirectories.some((directory) => path.startsWith(directory))) return true;
  if (/^packages\/[^/]+\/(?:src|tests)\//u.test(path)) return false;
  if (/^\.changeset\/[^/]+\.md$/u.test(path)) return false;
  if (["README.md", "CONTRIBUTING.md", "CONTEXT-MAP.md", "NOTICE.md", "LICENSE"].includes(path)) {
    return false;
  }
  if (/^(?:apps|packages)\/[^/]+\/CONTEXT\.md$/u.test(path)) return false;
  return true;
}

export function detectNativeScope(repository: string, base: string | undefined): boolean {
  if (base === undefined || !/^[a-f\d]{40}$/u.test(base) || /^0+$/u.test(base)) return true;
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter(Boolean)
      .some(requiresNative);
  } catch {
    return true;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(import.meta.dirname, "../..");
  const output = `native=${detectNativeScope(repository, process.env.BASE_SHA)}\n`;
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
