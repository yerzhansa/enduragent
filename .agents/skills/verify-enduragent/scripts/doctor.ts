import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(import.meta.url);
const problems: string[] = [];
const notes: string[] = [];

const major = Number(process.versions.node.split(".")[0]);
if (major >= 24) notes.push(`node ${process.versions.node} ok`);
else problems.push(`node ${process.versions.node}; the repository requires 24 or newer`);

if (process.platform !== "darwin") {
  problems.push(`platform ${process.platform}; this CDP fixture is macOS-only in this checkout`);
} else {
  notes.push("platform darwin ok");
}

try {
  const loaded: unknown = require(join(repoRoot, "apps/desktop/node_modules/electron"));
  if (typeof loaded === "string") notes.push(`electron binary at ${loaded}`);
  else problems.push("apps/desktop resolved Electron without an executable path");
} catch {
  problems.push("electron is not installed under apps/desktop; run pnpm install");
}

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    const modified = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (modified > newest) newest = modified;
  }
  return newest;
}

const mainOutput = join(repoRoot, "apps/desktop/out/main/index.js");
if (!existsSync(mainOutput)) {
  problems.push("apps/desktop/out/main/index.js is missing; run the Prepare build");
} else {
  const outputMtime = statSync(mainOutput).mtimeMs;
  const sourceDirectories = [
    join(repoRoot, "apps/desktop/src"),
    join(repoRoot, "apps/desktop-renderer/src"),
  ];
  const stale = sourceDirectories.filter(
    (directory) => existsSync(directory) && newestMtime(directory) > outputMtime,
  );
  if (stale.length > 0) {
    problems.push(`desktop out is older than source in ${stale.join(", ")}; rebuild before driving`);
  } else {
    notes.push("apps/desktop/out is newer than desktop and renderer source");
  }
}

const loopbackAvailable = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});
if (loopbackAvailable) notes.push("loopback 127.0.0.1 is available");
else problems.push("cannot bind 127.0.0.1; the fixture RPC server needs loopback");

const leftovers = readdirSync("/tmp").filter((name) => name.startsWith("eap-"));
if (leftovers.length > 0) {
  const preview = leftovers.slice(0, 5).join(", ");
  const remainder = leftovers.length > 5 ? ` and ${leftovers.length - 5} more` : "";
  notes.push(
    `${leftovers.length} old fixture directories found (${preview}${remainder}); report them and do not delete state another run may own`,
  );
} else {
  notes.push("no leftover /tmp/eap-* directories");
}

for (const note of notes) console.log(`ok: ${note}`);
for (const problem of problems) console.error(`PROBLEM: ${problem}`);
console.log(problems.length === 0 ? "DOCTOR: ready to drive" : "DOCTOR: not ready");
if (problems.length > 0) process.exitCode = 1;
