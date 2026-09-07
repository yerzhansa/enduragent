import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function uiReleaseVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^https:\/\/github\.com\/yerzhansa\/enduragent-ui\/releases\/download\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/enduragent-ui-\1\.tgz$/u.exec(
      value,
    );
  if (match === null || match[0] !== value) return undefined;
  const version = match[1]!;
  return version !== "0.0.0" &&
    version.split(".").every((part) => Number.isSafeInteger(Number(part)))
    ? version
    : undefined;
}

export function readUiReleaseLock(root: string): unknown {
  try {
    return parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

function hasPeerSuffix(value: string, url: string): boolean {
  if (!value.startsWith(`${url}(`)) return false;
  let depth = 0;
  for (const character of value.slice(url.length)) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) return false;
      depth -= 1;
    } else if (depth === 0 || !/[A-Za-z0-9@/._+:-]/u.test(character)) return false;
  }
  return depth === 0 && !value.includes("()");
}

export function uiReleaseLockMatches(
  lockfile: unknown,
  importer: string,
  url: string,
  version: string,
): boolean {
  const lock = record(lockfile);
  const dependencies = record(record(record(lock.importers)[importer]).dependencies);
  const dependency = record(dependencies["@enduragent/ui"]);
  if (
    dependency.specifier !== url ||
    typeof dependency.version !== "string" ||
    (dependency.version !== url && !hasPeerSuffix(dependency.version, url)) ||
    !Object.hasOwn(record(lock.snapshots), `@enduragent/ui@${dependency.version}`)
  )
    return false;
  const entry = record(record(lock.packages)[`@enduragent/ui@${url}`]);
  const resolution = record(entry.resolution);
  const integrity = resolution.integrity;
  return (
    entry.version === version &&
    resolution.tarball === url &&
    typeof integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity) &&
    Buffer.from(integrity.slice(7), "base64").toString("base64") === integrity.slice(7)
  );
}
