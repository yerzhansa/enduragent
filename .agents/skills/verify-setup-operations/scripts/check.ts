import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specFile = join(skillDir, "model", "SetupOperations.tla");

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

const ALL_EVENTS = [
  "coach-exit",
  "slow-intervals",
  "slow-coach",
  "page-crash",
  "window-close",
  "coach-save",
  "telegram",
  "openrouter",
] as const;
type Event = (typeof ALL_EVENTS)[number];

const without = (...removed: Event[]): Event[] => ALL_EVENTS.filter((event) => !removed.includes(event));

// Each scenario turns some environment events and athlete actions off, so a
// rule's shortest counterexample is the path its finding is about.
const SCENARIOS: Record<string, readonly Event[]> = {
  everything: ALL_EVENTS,
  "crash-not-close": without("window-close"),
  "close-not-crash": without("page-crash"),
  "no-slow-coach": without("slow-coach"),
};

type Expectation = "holds" | "breaks";
interface Check {
  readonly rule: string;
  readonly kind: "invariant" | "property";
  readonly scenario: keyof typeof SCENARIOS;
  readonly expect: Expectation;
  readonly finding: string;
}

// The expected result of every rule at the sync commit in ../SKILL.md.
// A fix flips its row to "holds" in the same pull request that changes the model.
const CHECKS: readonly Check[] = [
  { rule: "TypeOK", kind: "invariant", scenario: "everything", expect: "holds", finding: "model sanity" },
  { rule: "NoRestartLostBehindAPerson", kind: "invariant", scenario: "everything", expect: "holds", finding: "#396, fixed by #1205" },
  { rule: "NoRestartLostToSlowIntervals", kind: "invariant", scenario: "everything", expect: "breaks", finding: "#396 second trigger (intervals.icu owner)" },
  { rule: "NothingWaitsBehindAPerson", kind: "invariant", scenario: "everything", expect: "holds", finding: "#396, fixed by #1205" },
  { rule: "ChatGptActivationHasSetupAlone", kind: "invariant", scenario: "everything", expect: "holds", finding: "#398, fixed by #398 PR" },
  { rule: "IntervalsSignInHasSetupAlone", kind: "invariant", scenario: "everything", expect: "holds", finding: "#398 (OpenRouter widening), fixed by #398 PR" },
  { rule: "OpenRouterSignInHasSetupAlone", kind: "invariant", scenario: "everything", expect: "holds", finding: "#398 (OpenRouter widening), fixed by #398 PR" },
  { rule: "KeySaveHasSetupAlone", kind: "invariant", scenario: "everything", expect: "holds", finding: "#398, fixed by #398 PR" },
  { rule: "ChatGptSignInHasSetupAlone", kind: "invariant", scenario: "everything", expect: "holds", finding: "control" },
  { rule: "BusySetupNamesItsOwner", kind: "invariant", scenario: "everything", expect: "holds", finding: "control" },
  { rule: "ChatGptSignInEndsWithItsPage", kind: "invariant", scenario: "crash-not-close", expect: "breaks", finding: "#400" },
  { rule: "IntervalsSignInEndsWithItsPage", kind: "invariant", scenario: "crash-not-close", expect: "breaks", finding: "#400" },
  { rule: "IntervalsSignInEndsWithItsPage", kind: "invariant", scenario: "close-not-crash", expect: "holds", finding: "#398 (Setup forgot the sign-in, so pagehide cannot cancel it), fixed by #398 PR" },
  { rule: "ChatGptSignInEndsWithItsPage", kind: "invariant", scenario: "close-not-crash", expect: "breaks", finding: "lead: cancel lost when closed runs first" },
  { rule: "OpenRouterSignInEndsWithItsPage", kind: "invariant", scenario: "everything", expect: "holds", finding: "control: closed disposes the auth" },
  { rule: "SetupShowsTheActiveCoach", kind: "invariant", scenario: "everything", expect: "breaks", finding: "#395" },
  { rule: "NeverSentToSetupWithAWorkingCoach", kind: "property", scenario: "everything", expect: "breaks", finding: "#419" },
  { rule: "NeverSentToSetupWithAWorkingCoach", kind: "property", scenario: "no-slow-coach", expect: "breaks", finding: "#395" },
];

interface Options {
  readonly only: string | undefined;
  readonly trace: boolean;
  readonly keep: string | undefined;
}

function parseOptions(argv: readonly string[]): Options {
  let only: string | undefined;
  let trace = false;
  let keep: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--rule") only = argv[++index];
    else if (argument === "--trace") trace = true;
    else if (argument === "--keep") keep = argv[++index];
    else throw new Error(`unknown argument ${argument}; use --rule NAME, --trace, --keep DIR`);
  }
  return { only, trace, keep };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function tlaTools(): Promise<string> {
  const configured = process.env.TLA2TOOLS;
  const jar =
    configured ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "enduragent", `tla2tools-${TLC_VERSION}.jar`);
  if (!existsSync(jar)) {
    if (configured !== undefined) throw new Error(`TLA2TOOLS points at ${jar}, which does not exist`);
    mkdirSync(dirname(jar), { recursive: true });
    const response = await fetch(TLC_URL);
    if (!response.ok) throw new Error(`downloading TLC ${TLC_VERSION} failed: HTTP ${response.status}`);
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
  }
  const digest = sha256(jar);
  if (digest !== TLC_SHA256) {
    throw new Error(`${jar} is not TLC ${TLC_VERSION} (sha256 ${digest}); remove it or point TLA2TOOLS at the release jar`);
  }
  return jar;
}

function javaBinary(): string {
  const java = process.env.JAVA ?? "java";
  const probe = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`no Java runtime at "${java}"; install Java 11 or newer, or set JAVA to its java binary`);
  }
  return java;
}

function config(checks: readonly Check[], events: readonly Event[]): string {
  const lines = [
    "CONSTANTS",
    "  MaxPage = 2",
    "  MaxAthleteSteps = 5",
    `  Events = {${events.map((event) => `"${event}"`).join(", ")}}`,
    "SPECIFICATION Spec",
    "CHECK_DEADLOCK FALSE",
  ];
  for (const check of checks) lines.push(`${check.kind === "invariant" ? "INVARIANT" : "PROPERTY"} ${check.rule}`);
  return `${lines.join("\n")}\n`;
}

interface Run {
  readonly broken: string | null;
  readonly states: string;
  readonly output: string;
}

function runTlc(java: string, jar: string, workDir: string, name: string, checks: readonly Check[]): Run {
  const scenario = checks[0].scenario;
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(specFile, join(dir, "SetupOperations.tla"));
  writeFileSync(join(dir, "SetupOperations.cfg"), config(checks, SCENARIOS[scenario]));
  const result = spawnSync(
    java,
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "1",
      "-cleanup",
      "-metadir",
      join(dir, "states"),
      "-config",
      "SetupOperations.cfg",
      "SetupOperations.tla",
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(join(dir, "tlc.out"), output);
  const states = [...output.matchAll(/(\d[\d,]*) distinct states found/g)].at(-1)?.[1] ?? "?";
  const violated = /(?:Invariant|Action property|Temporal property) (\w+) is violated/.exec(output);
  if (violated !== null) return { broken: violated[1], states, output };
  if (/Temporal properties were violated/.test(output)) return { broken: checks[0].rule, states, output };
  if (output.includes("Model checking completed. No error has been found.")) return { broken: null, states, output };
  throw new Error(`TLC did not finish for ${name}; see ${join(dir, "tlc.out")}\n${output.slice(-2000)}`);
}

function traceOf(output: string): string {
  const start = output.indexOf("State 1:");
  if (start < 0) return output;
  const end = output.search(/\n\d+ states generated/);
  return output.slice(start, end < 0 ? undefined : end).trim();
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const java = javaBinary();
  const jar = await tlaTools();
  const workDir = options.keep === undefined ? mkdtempSync(join(tmpdir(), "setup-operations-")) : resolve(options.keep);
  mkdirSync(workDir, { recursive: true });
  const selected = CHECKS.filter((check) => options.only === undefined || check.rule === options.only);
  if (selected.length === 0) throw new Error(`no check named ${options.only}`);

  const rows: string[][] = [];
  let mismatches = 0;
  const record = (check: Check, got: Expectation, states: string): void => {
    const ok = got === check.expect;
    if (!ok) mismatches += 1;
    rows.push([ok ? "ok" : "MISMATCH", check.rule, check.scenario, check.expect, got, states, check.finding]);
  };

  for (const scenario of Object.keys(SCENARIOS)) {
    let holding = selected.filter((check) => check.scenario === scenario && check.expect === "holds");
    for (let attempt = 1; holding.length > 0; attempt += 1) {
      const run = runTlc(java, jar, workDir, `${scenario}-holds-${attempt}`, holding);
      const broken = holding.find((check) => check.rule === run.broken);
      if (broken === undefined) {
        for (const check of holding) record(check, "holds", run.states);
        break;
      }
      record(broken, "breaks", run.states);
      process.stdout.write(`\n${broken.rule} broke in ${scenario}:\n${traceOf(run.output)}\n`);
      holding = holding.filter((check) => check !== broken);
    }
    for (const check of selected.filter((entry) => entry.scenario === scenario && entry.expect === "breaks")) {
      const run = runTlc(java, jar, workDir, `${scenario}-${check.rule}`, [check]);
      const got: Expectation = run.broken === check.rule ? "breaks" : "holds";
      record(check, got, run.states);
      if (options.trace && got === "breaks") {
        process.stdout.write(`\n${check.rule} in ${scenario} (${check.finding}):\n${traceOf(run.output)}\n`);
      }
    }
  }

  const header = ["", "rule", "scenario", "expected", "result", "states", "finding"];
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column].length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}\n`);
  }
  process.stdout.write(`\nTLC ${TLC_VERSION}; runs in ${workDir}\n`);
  if (options.keep === undefined) rmSync(workDir, { recursive: true, force: true });
  if (mismatches > 0) {
    process.stdout.write(`${mismatches} result(s) differ from the expected findings.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Every rule matches its expected result.\n");
  }
}

await main();
