import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.argv.find((arg) => arg.startsWith("--repo="))?.slice(7) ?? process.cwd());
const binary = join(repo, "packages/cycling-coach/dist/index.js");
assert.equal(existsSync(binary), true, "Built cycling-coach binary is missing");

const evidenceRoot = join(tmpdir(), "enduragent-verify-npm");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(evidenceRoot, "setup-"));
const home = mkdtempSync(join(tmpdir(), "enduragent-npm-setup-"));
const rows = 40;
const columns = 120;

const python = `
import os, pty, select, struct, fcntl, termios, sys
node, binary = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ${rows}, ${columns}, 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.execv(node, [node, binary, "setup"])
os.close(slave)
output = b""
def read_for(seconds):
    global output
    deadline = seconds
    while deadline > 0:
        ready, _, _ = select.select([master], [], [], 0.1)
        deadline -= 0.1
        if master in ready:
            try:
                output += os.read(master, 65536)
            except OSError:
                return
def wait_for(text, seconds):
    read_for(0.2)
    for _ in range(int(seconds * 10)):
        if text.encode() in output:
            return
        read_for(0.1)
    raise SystemExit("missing " + text + "\\n" + output.decode("utf8", "replace"))
def send(data):
    os.write(master, data)
wait_for("LLM provider", 30)
for _ in range(5):
    send(b"\\x1b[B")
    read_for(0.05)
send(b"\\r")
wait_for("Other (type model name)", 15)
for _ in range(3):
    send(b"\\x1b[B")
    read_for(0.05)
send(b"\\r")
wait_for("Model name", 15)
send(b"fictional-model\\r")
wait_for("Base URL", 15)
send(b"\\x03")
read_for(2)
_, status = os.waitpid(pid, 0)
os.close(master)
sys.stdout.buffer.write(output)
raise SystemExit(0 if os.WIFEXITED(status) else 1)
`;

const child = spawn("python3", ["-c", python, process.execPath, binary], {
  cwd: repo,
  env: {
    PATH: process.env.PATH ?? "",
    CYCLING_COACH_HOME: home,
    CYCLING_COACH_NO_UPDATE_CHECK: "1",
    ENDURAGENT_LANGUAGE: "en",
    HOME: home,
  },
});
let transcript = "";
child.stdout.on("data", (chunk: Buffer) => {
  transcript += chunk.toString("utf8");
});
child.stderr.on("data", (chunk: Buffer) => {
  transcript += chunk.toString("utf8");
});
const exitCode = await new Promise<number>((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolvePromise(code ?? 1));
});

function namedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...namedFiles(path));
    else if (entry.name === "config.yaml" || entry.name === "auth-profiles.json") found.push(path);
  }
  return found;
}

let failure: string | undefined;
try {
  assert.equal(exitCode, 0, `setup driver exited ${exitCode}\n${transcript}`);
  assert.equal(transcript.includes("Base URL (Enter for default)"), true, transcript);
  assert.equal(transcript.includes("Setup cancelled."), true, transcript);
  assert.equal(transcript.includes("Other (type model name)"), true, transcript);
  assert.deepEqual(namedFiles(home), []);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const sanitize = (value: string) => value.replaceAll(home, "<isolated-data-directory>").replaceAll(repo, "<checkout>");
  writeFileSync(join(evidence, "transcript.txt"), sanitize(transcript));
  rmSync(home, { recursive: true, force: true });
  const result = {
    scenario: "setup-cancel",
    status: failure === undefined ? "PASS" : "FAIL",
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    runtime: process.version,
    platform: process.platform,
    winsize: `${rows}x${columns}`,
    cleanup: { scratchRemoved: !existsSync(home) },
    ...(failure === undefined ? {} : { error: sanitize(failure) }),
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(`Evidence: ${evidence}`);
  if (failure !== undefined) console.error(sanitize(failure));
  else console.log("setup-cancel: Base URL cancelled and no config was written PASS");
}
