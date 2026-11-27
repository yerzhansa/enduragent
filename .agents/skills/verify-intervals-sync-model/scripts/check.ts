// Model-checks the window's coach connection, sync and stored intervals.icu
// sign-in against the code as it is now.
//
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts --trace <Rule>
//   node .agents/skills/verify-intervals-sync-model/scripts/check.ts --confirm
//
// Exit 0: every rule is where the code's facts say it should be.
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
import {
  COVERED,
  FLAGS,
  RULES,
  STEPS,
  type Covered,
  type Flags,
  type RuleFact,
  type Source,
} from "./facts.ts";

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
if (traceRule !== undefined && !RULES.some((rule) => rule.name === traceRule)) {
  console.error(`No rule named ${traceRule}. Rules: ${RULES.map((rule) => rule.name).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------- source scan

// Walks `text` from `from`, calling `visit` on each character outside strings
// and comments. Returns the index where `visit` returned true, or -1.
function scanCode(text: string, from: number, visit: (ch: string) => boolean): number {
  let quote: string | undefined;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (visit(ch)) return i;
  }
  return -1;
}

function matchClose(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  return scanCode(text, open, (ch) => {
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return true;
    }
    return false;
  });
}

function nthIndex(text: string, needle: string, nth: number): number {
  let at = -1;
  for (let count = 0; count < nth; count += 1) {
    at = text.indexOf(needle, at + 1);
    if (at === -1) return -1;
  }
  return at;
}

class AnchorLost extends Error {
  constructor(file: string, needle: string) {
    super(`${file}: cannot find ${JSON.stringify(needle.split("\n")[0])}`);
  }
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
  block(file, needle, nth = 1) {
    const text = source.read(file);
    const at = nthIndex(text, needle, nth);
    if (at === -1) throw new AnchorLost(file, needle);
    let parens = 0;
    const open = scanCode(text, at, (ch) => {
      if (ch === "(") parens += 1;
      else if (ch === ")") parens -= 1;
      return ch === "{" && parens === 0;
    });
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
    const end = scanCode(text, at, (ch) => {
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
      return (ch === ";" || ch === ",") && depth <= 0;
    });
    if (end === -1) throw new AnchorLost(file, needle);
    return text.slice(at, end + 1);
  },
  code(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  },
};

function extract(entry: Covered): string {
  return entry.kind === "block"
    ? source.block(entry.file, entry.needle, entry.nth)
    : source[entry.kind](entry.file, entry.needle);
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

const key = (entry: Covered): string =>
  `${entry.file} :: ${entry.needle}${entry.nth === undefined ? "" : ` #${entry.nth}`}`;

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
  readonly violated: string | undefined;
  readonly trace: readonly { action: string; changes: string[] }[];
  readonly distinct: string;
}

function config(flags: Flags, invariants: readonly string[]): string {
  const constants = FLAGS.map((flag) => `  ${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`);
  return [
    "CONSTANTS",
    ...constants,
    "SPECIFICATION Spec",
    `INVARIANTS ${invariants.join(" ")}`,
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
      .filter(([entry, value]) => previous.size > 0 && previous.get(entry) !== value)
      .map(([entry, value]) => `${entry} = ${value}`);
    steps.push({ action: header?.[1] ?? "?", changes });
    previous = values;
  }
  return steps;
}

function runTlc(java: string, jar: string, flags: Flags, invariants: readonly string[]): Run {
  const work = mkdtempSync(join(tmpdir(), "intervals-sync-model-"));
  try {
    writeFileSync(join(work, "CoachConnection.tla"), readFileSync(join(modelDir, "CoachConnection.tla")));
    writeFileSync(join(work, "MC.cfg"), config(flags, invariants));
    const result = spawnSync(
      java,
      [
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "4",
        "-config",
        "MC.cfg",
        "-metadir",
        join(work, "states"),
        "CoachConnection.tla",
      ],
      { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${result.stdout}${result.stderr}`;
    const violated = /Invariant (\w+) is violated/.exec(output)?.[1];
    const clean = output.includes("Model checking completed. No error has been found.");
    if (
      (violated === undefined && !clean) ||
      /Warning: The variable \w+ was changed while it is specified as UNCHANGED/.test(output)
    ) {
      console.error(output);
      throw new Error(`TLC did not finish cleanly on ${invariants.join(", ")}; the model needs fixing.`);
    }
    return {
      violated,
      trace: violated === undefined ? [] : parseTrace(output),
      distinct: [...output.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1] ?? "?",
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

const git = (...gitArgs: string[]): string =>
  spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
  syncCommit: string;
  fingerprints: Record<string, string>;
};

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

const problems: string[] = [];
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
if (!confirm && !skill.includes(coverage.syncCommit)) {
  problems.push(`SKILL.md does not name the sync commit ${coverage.syncCommit} from references/coverage.json.`);
}
const committedCfg = readFileSync(join(modelDir, "CoachConnection.cfg"), "utf8");
const cfgDrift = FLAGS.filter(
  (flag) => !committedCfg.includes(`${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`),
).map((flag) => flag.name);
if (cfgDrift.length > 0) {
  problems.push(
    `model/CoachConnection.cfg disagrees with the code on ${cfgDrift.join(", ")}. Set those constants to the values printed above.`,
  );
}
const changed = COVERED.filter((entry) => coverage.fingerprints[key(entry)] !== current[key(entry)]);

const java = findJava();
if (java === undefined) {
  console.error("No Java runtime. Install one (for example `brew install --cask temurin`) or set JAVA to a java binary.");
  process.exit(2);
}
const jar = tlcJar();

console.log(`Code facts at ${git("rev-parse", "--short=8", "HEAD")}:`);
for (const flag of FLAGS) console.log(`  ${flag.name} = ${flags[flag.name]}: ${flag.says}`);
console.log("");

const rules = RULES.filter((rule) => traceRule === undefined || rule.name === traceRule);
const causesOf = (rule: RuleFact, values: Flags) => rule.breaksWhen.filter((cause) => cause.when(values));

// Rules the code's facts say hold: one TLC pass, with TypeOK.
const holding = rules.filter((rule) => causesOf(rule, flags).length === 0);
const together = runTlc(java, jar, flags, ["TypeOK", ...holding.map((rule) => rule.name)]);
if (together.violated !== undefined) {
  problems.push(
    together.violated === "TypeOK"
      ? "TypeOK breaks: the model reached a value outside its declared types."
      : `${together.violated} breaks with no known cause. Either a fix is incomplete or the model is wrong.`,
  );
  console.log(`${together.violated}: BREAKS (UNEXPECTED: no known cause)`);
  printTrace(together);
  console.log("");
}
for (const rule of holding.filter((entry) => entry.name !== together.violated)) {
  console.log(`${rule.name}: holds`);
  console.log(`  ${rule.says}`);
  console.log("");
}
if (together.violated === undefined) console.log(`(${together.distinct} states checked)\n`);

// Rules with a known cause: each must break, with its counterexample.
const open = rules.filter((rule) => causesOf(rule, flags).length > 0);
for (const rule of open) {
  const causes = causesOf(rule, flags);
  const run = runTlc(java, jar, flags, [rule.name]);
  const label = causes
    .map((cause) =>
      cause.issue === undefined ? `REGRESSION: ${cause.because}` : `issue ${cause.issue}: ${cause.because}`,
    )
    .join("; ");
  if (run.violated === undefined) {
    console.log(`${rule.name}: holds (UNEXPECTED: holds although ${label})`);
    problems.push(`${rule.name} holds although its facts say it should break. Check the fact reading in facts.ts.`);
  } else {
    console.log(`${rule.name}: BREAKS (${label})`);
    console.log(`  ${rule.says}`);
    printTrace(run);
  }
  for (const cause of causes.filter((entry) => entry.issue === undefined)) {
    problems.push(`${rule.name} breaks because ${cause.because}.`);
  }
  console.log("");
}

// With every known cause removed, each open rule must hold: a break here is a
// new path, or a modeled fix that does not work.
if (open.length > 0) {
  const fixedFlags = Object.assign(
    { ...flags },
    ...open.flatMap((rule) => rule.breaksWhen.map((cause) => cause.fixedWith)),
  ) as Flags;
  const fixed = runTlc(java, jar, fixedFlags, open.map((rule) => rule.name));
  if (fixed.violated !== undefined) {
    problems.push(`${fixed.violated} breaks even with every known cause removed.`);
    console.log(`With every known cause removed, ${fixed.violated} still BREAKS:`);
    printTrace(fixed);
  } else {
    console.log(`With every known cause removed, all ${open.length} open rules hold (${fixed.distinct} states).`);
  }
  console.log("");
}

// Each witness must fail, and each rule must break with its break flags.
for (const rule of rules) {
  if (runTlc(java, jar, flags, [rule.witness]).violated === undefined) {
    problems.push(`${rule.witness} never fails, so ${rule.name} is about a state the model never reaches.`);
  }
  if (runTlc(java, jar, { ...flags, ...rule.breakWith }, [rule.name]).violated === undefined) {
    problems.push(`${rule.name} does not break with ${JSON.stringify(rule.breakWith)}, so it cannot fail.`);
  }
}

for (const problem of problems) console.error(`PROBLEM: ${problem}`);
if (problems.length > 0) process.exit(1);

if (confirm) {
  const dirty = git("status", "--porcelain", "--", ...new Set(COVERED.map((entry) => entry.file)));
  if (dirty !== "") {
    console.error(`Commit the covered code first, then confirm in a separate commit:\n${dirty}`);
    process.exit(1);
  }
  coverage.fingerprints = current;
  const coveredFiles = [...new Set(COVERED.map((entry) => entry.file))];
  const base = git("merge-base", "HEAD", "origin/main");
  const sameAsMain =
    base !== "" &&
    spawnSync("git", ["diff", "--quiet", base, "HEAD", "--", ...coveredFiles], { cwd: repoRoot })
      .status === 0;
  coverage.syncCommit = git("rev-parse", "--short=8", sameAsMain ? base : "HEAD");
  writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
  console.log(`Recorded fingerprints at ${coverage.syncCommit}. Put that commit on the "Sync commit" line in SKILL.md.`);
  process.exit(0);
}

if (changed.length > 0) {
  console.error(`STALE: covered code changed since sync commit ${coverage.syncCommit}:`);
  for (const entry of changed) console.error(`  ${entry.file}: ${entry.needle.split("\n")[0]}  (models ${entry.models})`);
  console.error("Re-read each one against the model. Then run with --confirm and put the new commit in SKILL.md.");
  process.exit(3);
}
console.log(`OK. Model and code agree as of sync commit ${coverage.syncCommit}.`);
