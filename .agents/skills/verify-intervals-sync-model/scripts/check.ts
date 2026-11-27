// Model-checks the window's coach connection, sync and stored intervals.icu
// sign-in against the code as it is now.
//
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts --trace <Rule>
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts --confirm
//
// Exit 0: every rule is where the code's flags say it should be.
// Exit 1: a rule broke that should hold, a fixed rule still breaks, a witness
//         or mutant did not fail, or TLC reported a modeling error.
// Exit 2: the tools are missing.
// Exit 3: covered code changed since the sync commit (see SKILL.md).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERED, FLAGS, RULES, STEPS, type Covered, type Flags, type Source } from "./facts.ts";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(skillRoot, "../../..");
const modelDir = join(skillRoot, "model");
const coveragePath = join(skillRoot, "references/coverage.json");
const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

const args = process.argv.slice(2);
const traceRule = args.includes("--trace") ? args[args.indexOf("--trace") + 1] : undefined;
const confirm = args.includes("--confirm");

// ---------------------------------------------------------------- source scan

function matchClose(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "/" && next === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const files = new Map<string, string>();
const source: Source = {
  read(file) {
    let text = files.get(file);
    if (text === undefined) {
      const path = join(repoRoot, file);
      if (!existsSync(path)) throw new AnchorLost(file, "(file)");
      text = readFileSync(path, "utf8");
      files.set(file, text);
    }
    return text;
  },
  block(file, needle) {
    const text = source.read(file);
    const at = text.indexOf(needle);
    if (at === -1) throw new AnchorLost(file, needle);
    const open = text.indexOf("{", needle.endsWith("{") ? at + needle.length - 1 : at + needle.length);
    const close = open === -1 ? -1 : matchClose(text, open, "{", "}");
    if (close === -1) throw new AnchorLost(file, needle);
    return text.slice(at, close + 1);
  },
  call(file, needle) {
    const text = source.read(file);
    const at = text.indexOf(needle);
    if (at === -1) throw new AnchorLost(file, needle);
    let depth = 0;
    let open = -1;
    for (let i = at; i >= 0; i -= 1) {
      if (text[i] === ")") depth += 1;
      if (text[i] === "(") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    const close = open === -1 ? -1 : matchClose(text, open, "(", ")");
    if (close === -1) throw new AnchorLost(file, needle);
    return text.slice(open, close + 1);
  },
  statement(file, needle) {
    const text = source.read(file);
    const at = text.indexOf(needle);
    if (at === -1) throw new AnchorLost(file, needle);
    let depth = 0;
    for (let i = at; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
      if ((ch === ";" || ch === ",") && depth <= 0) return text.slice(at, i + 1);
    }
    throw new AnchorLost(file, needle);
  },
};

class AnchorLost extends Error {
  constructor(file: string, needle: string) {
    super(`${file}: cannot find ${JSON.stringify(needle.split("\n")[0])}`);
  }
}

function extract(entry: Covered): string {
  return source[entry.kind](entry.file, entry.needle);
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- tools

function findJava(): string | undefined {
  const candidates = [
    process.env.JAVA,
    process.env.JAVA_HOME === undefined ? undefined : join(process.env.JAVA_HOME, "bin/java"),
    "java",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

function tlcJar(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const jar = join(cacheRoot, "enduragent", `tla2tools-${TLC_VERSION}.jar`);
  const verified = (): boolean =>
    existsSync(jar) &&
    createHash("sha256").update(readFileSync(jar)).digest("hex") === TLC_SHA256;
  if (verified()) return jar;
  mkdirSync(dirname(jar), { recursive: true });
  const download = spawnSync("curl", ["-fsSL", "-o", jar, TLC_URL], { stdio: "inherit" });
  if (download.status !== 0 || !verified()) {
    rmSync(jar, { force: true });
    console.error(`Could not fetch TLC ${TLC_VERSION} from ${TLC_URL} with SHA-256 ${TLC_SHA256}.`);
    process.exit(2);
  }
  return jar;
}

// ---------------------------------------------------------------- TLC

interface Run {
  readonly violated: boolean;
  readonly trace: readonly { action: string; changes: string[] }[];
  readonly distinct: string;
}

function config(flags: Flags, invariant: string): string {
  const constants = FLAGS.map((flag) => `  ${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`);
  return [
    "CONSTANTS",
    ...constants,
    "SPECIFICATION Spec",
    `INVARIANT ${invariant}`,
    "CHECK_DEADLOCK FALSE",
    "",
  ].join("\n");
}

function parseTrace(output: string): Run["trace"] {
  const steps: { action: string; changes: string[] }[] = [];
  let previous = new Map<string, string>();
  for (const chunk of output.split(/\n(?=State \d+: )/).slice(1)) {
    const header = /^State \d+: <?(\w+)/.exec(chunk);
    const values = new Map<string, string>();
    let name: string | undefined;
    for (const line of chunk.split("\n").slice(1)) {
      const assignment = /^\/\\ (\w+) = (.*)$/.exec(line);
      if (assignment !== null) {
        name = assignment[1]!;
        values.set(name, assignment[2]!);
      } else if (name !== undefined && line.startsWith(" ")) {
        values.set(name, `${values.get(name)} ${line.trim()}`);
      } else if (line.trim() === "") break;
    }
    const changes = [...values]
      .filter(([key, value]) => previous.size > 0 && previous.get(key) !== value)
      .map(([key, value]) => `${key} = ${value}`);
    steps.push({ action: header?.[1] ?? "?", changes });
    previous = values;
  }
  return steps;
}

function runTlc(java: string, jar: string, flags: Flags, invariant: string): Run {
  const work = mkdtempSync(join(tmpdir(), "intervals-sync-model-"));
  try {
    writeFileSync(join(work, "CoachConnection.tla"), readFileSync(join(modelDir, "CoachConnection.tla")));
    writeFileSync(join(work, "MC.cfg"), config(flags, invariant));
    const result = spawnSync(
      java,
      [
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "2",
        "-config",
        "MC.cfg",
        "-metadir",
        join(work, "states"),
        "CoachConnection.tla",
      ],
      { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${result.stdout}${result.stderr}`;
    const violated = output.includes(`Invariant ${invariant} is violated`);
    const clean = output.includes("Model checking completed. No error has been found.");
    if ((!violated && !clean) || /Warning: The variable \w+ was changed while it is specified as UNCHANGED/.test(output)) {
      console.error(output);
      throw new Error(`TLC did not finish cleanly on ${invariant}; the model needs fixing.`);
    }
    return {
      violated,
      trace: violated ? parseTrace(output) : [],
      distinct: /(\d+) distinct states found/.exec(output)?.[1] ?? "?",
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function printTrace(run: Run): void {
  run.trace.forEach((step, index) => {
    const words = STEPS[step.action] ?? step.action;
    console.log(`    ${index + 1}. ${words} [${step.action}]`);
    if (traceRule !== undefined) for (const change of step.changes) console.log(`         ${change}`);
  });
}

// ---------------------------------------------------------------- main

const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
  syncCommit: string;
  fingerprints: Record<string, string>;
};
const key = (entry: Covered): string => `${entry.file} :: ${entry.needle}`;

let flags: Flags;
const current: Record<string, string> = {};
try {
  flags = Object.fromEntries(FLAGS.map((flag) => [flag.name, flag.read(source)])) as Flags;
  for (const entry of COVERED) current[key(entry)] = fingerprint(extract(entry));
} catch (error) {
  if (!(error instanceof AnchorLost)) throw error;
  console.error(`STALE: ${error.message}. The code moved; re-read it, then update scripts/facts.ts.`);
  process.exit(3);
}

const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
if (!skill.includes(coverage.syncCommit)) {
  console.error(`SKILL.md does not name the sync commit ${coverage.syncCommit} from references/coverage.json.`);
  process.exit(1);
}

const committedCfg = readFileSync(join(modelDir, "CoachConnection.cfg"), "utf8");
const cfgDrift = FLAGS.filter(
  (flag) => !committedCfg.includes(`${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`),
).map((flag) => flag.name);

if (confirm) {
  coverage.fingerprints = current;
  const head = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  coverage.syncCommit = head.stdout.trim();
  writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
  console.log(`Recorded fingerprints at ${coverage.syncCommit}. Put that commit in SKILL.md too.`);
  process.exit(0);
}

const changed = COVERED.filter((entry) => coverage.fingerprints[key(entry)] !== current[key(entry)]);

const java = findJava();
if (java === undefined) {
  console.error("No Java runtime. Install one (for example `brew install --cask temurin`) or set JAVA to a java binary.");
  process.exit(2);
}
const jar = tlcJar();

console.log(`Code facts at ${spawnSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim()}:`);
for (const flag of FLAGS) console.log(`  ${flag.name} = ${flags[flag.name]}: ${flag.says}`);
console.log("");

const problems: string[] = [];
if (runTlc(java, jar, flags, "TypeOK").violated) {
  problems.push("TypeOK breaks: the model reached a value outside its declared types.");
}
for (const rule of RULES.filter((entry) => traceRule === undefined || entry.name === traceRule)) {
  const causes = rule.breaksWhen.filter((cause) => cause.when(flags));
  const run = runTlc(java, jar, flags, rule.name);
  const label = causes.map((cause) => (cause.issue === undefined ? `REGRESSION: ${cause.because}` : `issue ${cause.issue}: ${cause.because}`));
  const verdict = run.violated
    ? causes.length === 0
      ? "UNEXPECTED: no known cause"
      : label.join("; ")
    : causes.length === 0
      ? "holds"
      : `UNEXPECTED: holds although ${label.join("; ")}`;
  console.log(`${rule.name}: ${run.violated ? "BREAKS" : "holds"} (${verdict}; ${run.distinct} states)`);
  console.log(`  ${rule.says}`);
  if (run.violated) printTrace(run);
  if (verdict.startsWith("UNEXPECTED")) {
    problems.push(
      run.violated
        ? `${rule.name} breaks with no known cause. Either a fix is incomplete or the model is wrong.`
        : `${rule.name} holds although its flags say it should break. Check the flag reading in facts.ts.`,
    );
  }
  for (const cause of causes.filter((entry) => entry.issue === undefined)) {
    problems.push(`${rule.name} breaks because ${cause.because}.`);
  }
  const witness = runTlc(java, jar, flags, rule.witness);
  if (!witness.violated) problems.push(`${rule.witness} never fails, so ${rule.name} is about a state the model never reaches.`);
  const mutant = runTlc(java, jar, { ...flags, ...rule.breakWith }, rule.name);
  if (!mutant.violated) problems.push(`${rule.name} does not break with ${JSON.stringify(rule.breakWith)}, so it cannot fail.`);
  console.log("");
}

if (cfgDrift.length > 0) {
  problems.push(`model/CoachConnection.cfg disagrees with the code on ${cfgDrift.join(", ")}. Set those constants to the values printed above.`);
}
for (const problem of problems) console.error(`PROBLEM: ${problem}`);
if (problems.length > 0) process.exit(1);

if (changed.length > 0) {
  console.error(`STALE: covered code changed since sync commit ${coverage.syncCommit}:`);
  for (const entry of changed) console.error(`  ${entry.file}: ${entry.needle.split("\n")[0]}  (models ${entry.models})`);
  console.error("Re-read each one against the model. Then run with --confirm and put the new commit in SKILL.md.");
  process.exit(3);
}
console.log(`OK. Model and code agree as of sync commit ${coverage.syncCommit}.`);
