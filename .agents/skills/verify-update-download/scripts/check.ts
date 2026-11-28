// Model-checks the desktop auto-update and download state machines against
// the current TypeScript source files with TLC 1.7.4.
//
//   node .agents/skills/verify-update-download/scripts/check.ts
//   node .agents/skills/verify-update-download/scripts/check.ts --trace <Rule>
//   node .agents/skills/verify-update-download/scripts/check.ts --keep <Dir>
//   node .agents/skills/verify-update-download/scripts/check.ts --confirm
//
// Exit 0: every rule matches the code's extracted facts and all fixed/control checks pass.
// Exit 1: a guarded rule broke, an open finding unexpectedly held, all-fixed broke,
//         a witness or mutant did not fail, or TLC hit a model error.
// Exit 2: Java or TLC is missing.
// Exit 3: covered code changed since the sync commit (see SKILL.md).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

interface Options {
  readonly traceRule: string | undefined;
  readonly keepDir: string | undefined;
  readonly confirm: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let traceRule: string | undefined;
  let keepDir: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--trace") traceRule = argv[++i];
    else if (arg === "--keep") keepDir = argv[++i];
    else if (arg === "--confirm") confirm = true;
    else {
      console.error(`Unknown argument ${arg}; use --trace <Rule>, --keep <Dir>, or --confirm.`);
      process.exit(1);
    }
  }
  if (confirm && traceRule !== undefined) {
    console.error("--confirm checks every rule; run it without --trace.");
    process.exit(1);
  }
  if (traceRule !== undefined && !RULES.some((rule) => rule.name === traceRule)) {
    console.error(
      `No rule named ${traceRule}. Rules: ${RULES.map((rule) => rule.name).join(", ")}`,
    );
    process.exit(1);
  }
  return { traceRule, keepDir, confirm };
}

// ---------------------------------------------------------------- source scan

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

const coverageKey = (entry: Covered): string =>
  `${entry.file} :: ${entry.needle}${entry.nth === undefined ? "" : ` #${entry.nth}`}`;

// ---------------------------------------------------------------- tools

function miseJavaCandidates(): string[] {
  const root = join(homedir(), ".local", "share", "mise", "installs", "java");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((entry) => !entry.startsWith("."))
      .flatMap((entry) => [
        join(root, entry, "bin", "java"),
        join(root, entry, "Contents", "Home", "bin", "java"),
      ]);
  } catch {
    return [];
  }
}

function findJava(): string | undefined {
  const candidates = [
    process.env.JAVA,
    process.env.JAVA_HOME === undefined ? undefined : join(process.env.JAVA_HOME, "bin/java"),
    "java",
    ...miseJavaCandidates(),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

function tlcJar(): string {
  const configured = process.env.TLA2TOOLS;
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const jar = configured ?? join(cacheRoot, "enduragent", `tla2tools-${TLC_VERSION}.jar`);
  const verified = (): boolean =>
    existsSync(jar) && createHash("sha256").update(readFileSync(jar)).digest("hex") === TLC_SHA256;
  if (verified()) return jar;
  if (configured !== undefined) {
    console.error(
      `TLA2TOOLS points at ${jar}, which is missing or does not match TLC ${TLC_VERSION}.`,
    );
    process.exit(2);
  }
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

function configText(flags: Flags, invariants: readonly string[], maxChecks = 2): string {
  const constants = FLAGS.map((flag) => `  ${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`);
  return [
    "CONSTANTS",
    ...constants,
    `  MaxChecks = ${maxChecks}`,
    '  Platform = "darwin"',
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

function runTlc(
  java: string,
  jar: string,
  runRoot: string,
  name: string,
  specModule: string,
  cfg: string,
): Run {
  const work = join(runRoot, name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, `${specModule}.tla`), readFileSync(join(modelDir, `${specModule}.tla`)));
  writeFileSync(join(work, `${specModule}.cfg`), cfg);
  const result = spawnSync(
    java,
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "4",
      "-cleanup",
      "-config",
      `${specModule}.cfg`,
      "-metadir",
      join(work, "states"),
      `${specModule}.tla`,
    ],
    { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(join(work, "tlc.out"), output);
  const violated = /Invariant (\w+) is violated/.exec(output)?.[1];
  const clean = output.includes("Model checking completed. No error has been found.");
  if (
    (violated === undefined && !clean) ||
    /Warning: The variable \w+ was changed while it is specified as UNCHANGED/.test(output)
  ) {
    console.error(output);
    throw new Error(`TLC did not finish cleanly for ${name}; the model needs fixing.`);
  }
  return {
    violated,
    trace: violated === undefined ? [] : parseTrace(output),
    distinct: [...output.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1] ?? "?",
  };
}

function printTrace(run: Run, showDiffs: boolean): void {
  run.trace.forEach((step, index) => {
    const words = STEPS[step.action] ?? step.action;
    console.log(`    ${index + 1}. ${words} [${step.action}]`);
    if (showDiffs) for (const change of step.changes) console.log(`         ${change}`);
  });
}

// ---------------------------------------------------------------- main

const options = parseOptions(process.argv.slice(2));
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
  for (const entry of COVERED) current[coverageKey(entry)] = fingerprint(extract(entry));
} catch (error) {
  if (!(error instanceof AnchorLost)) throw error;
  console.error(
    `STALE: ${error.message}. The code moved; re-read it, then update scripts/facts.ts.`,
  );
  process.exit(3);
}

const problems: string[] = [];
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
if (!options.confirm && !skill.includes(coverage.syncCommit)) {
  problems.push(
    `SKILL.md does not name the sync commit ${coverage.syncCommit} from references/coverage.json.`,
  );
}
const committedCfg = readFileSync(join(modelDir, "UpdateDownload.cfg"), "utf8");
const cfgDrift = FLAGS.filter(
  (flag) => !committedCfg.includes(`${flag.name} = ${flags[flag.name] ? "TRUE" : "FALSE"}`),
).map((flag) => flag.name);
if (cfgDrift.length > 0 && !options.confirm) {
  problems.push(
    `model/UpdateDownload.cfg disagrees with the code on ${cfgDrift.join(", ")}. Update the constants in model/UpdateDownload.cfg.`,
  );
}
const changed = COVERED.filter(
  (entry) => coverage.fingerprints[coverageKey(entry)] !== current[coverageKey(entry)],
);

const java = findJava();
if (java === undefined) {
  console.error(
    "No Java runtime found. Install Java 11+ (e.g. `brew install --cask temurin`) or set JAVA.",
  );
  process.exit(2);
}
const jar = tlcJar();

const runRoot =
  options.keepDir === undefined
    ? mkdtempSync(join(tmpdir(), "update-download-model-"))
    : resolve(options.keepDir);
mkdirSync(runRoot, { recursive: true });

try {
  console.log(`Code facts at ${git("rev-parse", "--short=8", "HEAD")}:`);
  for (const flag of FLAGS) console.log(`  ${flag.name} = ${flags[flag.name]}: ${flag.says}`);
  console.log("");

  const rules = RULES.filter(
    (rule) => options.traceRule === undefined || rule.name === options.traceRule,
  );
  const causesOf = (rule: RuleFact, values: Flags) =>
    rule.breaksWhen.filter((cause) => cause.when(values));

  // 1. Rules expected to hold on current code: one combined TLC pass with TypeOK.
  const holding = rules.filter((rule) => causesOf(rule, flags).length === 0);
  const together = runTlc(
    java,
    jar,
    runRoot,
    "holding-controls",
    "UpdateDownload",
    configText(flags, ["TypeOK", ...holding.map((rule) => rule.name)]),
  );
  if (together.violated !== undefined) {
    problems.push(
      together.violated === "TypeOK"
        ? "TypeOK breaks: the model reached a value outside its declared types."
        : `${together.violated} breaks with no known cause. Either a guard regressed or the model is wrong.`,
    );
    console.log(`${together.violated}: BREAKS (UNEXPECTED: no known cause)`);
    printTrace(together, options.traceRule !== undefined);
    console.log("");
  }
  for (const rule of holding.filter((entry) => entry.name !== together.violated)) {
    console.log(
      `${rule.name}: ${together.violated === undefined ? "holds" : "not checked (run stopped at the break above)"}`,
    );
    console.log(`  ${rule.says}`);
    console.log("");
  }
  if (together.violated === undefined)
    console.log(`(${together.distinct} distinct states checked)\n`);

  // 2. Rules with a known cause or regression: each must break, printing its shortest trace.
  const open = rules.filter((rule) => causesOf(rule, flags).length > 0);
  for (const rule of open) {
    const causes = causesOf(rule, flags);
    const run = runTlc(
      java,
      jar,
      runRoot,
      `open-${rule.name}`,
      "UpdateDownload",
      configText(flags, [rule.name]),
    );
    const label = causes
      .map((cause) =>
        cause.finding === undefined
          ? `REGRESSION: ${cause.because}`
          : `${cause.finding}: ${cause.because}`,
      )
      .join("; ");
    if (run.violated === undefined) {
      console.log(`${rule.name}: holds (UNEXPECTED: holds although ${label})`);
      problems.push(
        `${rule.name} holds although its facts say it should break. Check scripts/facts.ts.`,
      );
    } else {
      console.log(`${rule.name}: BREAKS (${label})`);
      console.log(`  ${rule.says}`);
      printTrace(run, options.traceRule !== undefined);
    }
    for (const cause of causes.filter((entry) => entry.finding === undefined)) {
      problems.push(`${rule.name} breaks (REGRESSION): ${cause.because}.`);
    }
    console.log("");
  }

  // 3. With every open cause fixed, all open rules must hold.
  if (open.length > 0) {
    const fixedFlags = Object.assign(
      { ...flags },
      ...open.flatMap((rule) => rule.breaksWhen.map((cause) => cause.fixedWith)),
    ) as Flags;
    const fixed = runTlc(
      java,
      jar,
      runRoot,
      "all-fixed",
      "UpdateDownload",
      configText(fixedFlags, ["TypeOK", ...open.map((rule) => rule.name)]),
    );
    if (fixed.violated !== undefined) {
      problems.push(`${fixed.violated} still breaks even with all known causes removed.`);
      console.log(`With all known causes removed, ${fixed.violated} still BREAKS:`);
      printTrace(fixed, options.traceRule !== undefined);
    } else {
      console.log(
        `With all known causes removed, all ${open.length} open rules hold (${fixed.distinct} distinct states).`,
      );
    }
    console.log("");
  }

  // 4. Witnesses (every rule premise is reachable) & mutants (every rule can fail).
  for (const rule of rules) {
    const witness = runTlc(
      java,
      jar,
      runRoot,
      `witness-${rule.name}`,
      "UpdateDownload",
      configText(flags, [rule.witness]),
    );
    if (witness.violated === undefined) {
      problems.push(`${rule.witness} never fails, so ${rule.name} checks an unreachable state.`);
    }
    const mutantFlags = { ...flags, ...rule.breakWith };
    const mutant = runTlc(
      java,
      jar,
      runRoot,
      `mutant-${rule.name}`,
      "UpdateDownload",
      configText(mutantFlags, [rule.name]),
    );
    if (mutant.violated === undefined) {
      problems.push(
        `${rule.name} does not break with ${JSON.stringify(rule.breakWith)}, so it cannot fail.`,
      );
    }
  }

  // 5. Verify AthleteUpdateFlow projection (small <= 500 state chart spec) stays deadlock-free and consistent.
  const athleteFixedCfg = [
    "CONSTANTS",
    "  DetachSettledOperation = TRUE",
    "  RelaunchOnInstallFailure = TRUE",
    "SPECIFICATION Spec",
    "INVARIANTS NoPermanentRetryWedge RestartToUpdateNeverStrandsApp",
    "",
  ].join("\n");
  const athleteRun = runTlc(
    java,
    jar,
    runRoot,
    "athlete-flow-fixed",
    "AthleteUpdateFlow",
    athleteFixedCfg,
  );
  if (athleteRun.violated !== undefined) {
    problems.push(`AthleteUpdateFlow fixed projection violated ${athleteRun.violated}.`);
  } else {
    console.log(
      `AthleteUpdateFlow fixed projection holds (${athleteRun.distinct} distinct states, deadlock-free).\n`,
    );
  }
} finally {
  if (options.keepDir === undefined) rmSync(runRoot, { recursive: true, force: true });
}

const printStale = (): void => {
  console.error(`STALE: covered code changed since sync commit ${coverage.syncCommit}:`);
  for (const entry of changed) {
    console.error(`  ${entry.file}: ${entry.needle.split("\n")[0]}  (models ${entry.models})`);
  }
  console.error(
    "Re-read each changed function against model/UpdateDownload.tla, then run with --confirm.",
  );
};

for (const problem of problems) console.error(`PROBLEM: ${problem}`);
if (problems.length > 0) {
  if (changed.length > 0 && !options.confirm) printStale();
  process.exit(1);
}

if (options.confirm) {
  const dirty = git("status", "--porcelain", "--", ...new Set(COVERED.map((entry) => entry.file)));
  if (dirty !== "") {
    console.error(`Commit covered code first, then run --confirm:\n${dirty}`);
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
  console.log(
    `Recorded fingerprints at ${coverage.syncCommit}. Update SKILL.md sync commit if changed.`,
  );
  process.exit(0);
}

if (changed.length > 0) {
  printStale();
  process.exit(3);
}
console.log(`OK. Model and code agree as of sync commit ${coverage.syncCommit}.`);
