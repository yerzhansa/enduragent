import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

interface Model {
  readonly dir: string;
  readonly module: string;
  readonly constraint?: string;
  readonly variants: Readonly<Record<string, readonly string[]>>;
}

const MODELS: Readonly<Record<string, Model>> = {
  icu: {
    dir: "icu",
    module: "WorkoutOnIcu",
    variants: {
      built: ['Fixes = {"readback", "recheck", "staleSet"}'],
      before: ["Fixes = {}"],
      "without-readback": ['Fixes = {"recheck", "staleSet"}'],
      "without-recheck": ['Fixes = {"readback", "staleSet"}'],
      "without-staleSet": ['Fixes = {"readback", "recheck"}'],
    },
  },
  outcome: {
    dir: "outcome",
    module: "WorkoutOutcome",
    variants: { built: ["Fixed = TRUE"], before: ["Fixed = FALSE"] },
  },
  text: {
    dir: "text",
    module: "CoachText",
    constraint: "Small",
    variants: { built: ["Fixed = TRUE"], before: ["Fixed = FALSE"] },
  },
  ftp: {
    dir: "ftp",
    module: "Ftp",
    variants: {
      built: ["Fixed = TRUE", 'AppStart = {"none"}', "Proposals = TRUE"],
      before: ["Fixed = FALSE", 'AppStart = {"none"}', "Proposals = TRUE"],
    },
  },
  weeks: {
    dir: "weeks",
    module: "WeekDelivery",
    variants: { built: ["Fixed = TRUE"], before: ["Fixed = FALSE"] },
  },
  plan: {
    dir: "plan",
    module: "PlanLifecycle",
    variants: { built: ["Fixed = TRUE"], before: ["Fixed = FALSE"] },
  },
};

type Expectation = "holds" | "breaks";

interface Check {
  readonly model: keyof typeof MODELS;
  readonly variant: string;
  readonly rule: string;
  readonly expect: Expectation;
  readonly test: string;
}

const RULES: Readonly<Record<keyof typeof MODELS, readonly (readonly [string, string])[]>> = {
  icu: [
    [
      "NeverUndoneByItself",
      "icu-copy: refreshes the card instead of putting back over a newer edit",
    ],
    ["KeptEditReplacedOnlyWhenFlagged", "icu-copy: marks a coach change shown before a Keep"],
    [
      "CardOnlyForRealChanges",
      "icu-copy: does not open the card when intervals.icu only stored our write",
    ],
    ["NoRewriteOfSameWorkout", "icu-copy: keeps every rule on every path"],
  ],
  outcome: [
    ["MissedIsTrue", "workout-outcome: says Not synced yet, not Missed"],
    ["RemovedIsNeverMissed", "workout-outcome: never counts Removed by you"],
    ["OnlyConfirmedCounts", "workout-outcome: does not count an unconfirmed ride"],
    ["RideOnTheDayIsSuggested", "workout-outcome: suggests a ride on the day a kept move set"],
  ],
  text: [
    ["NoReplyWithoutAsking", "coach-text: never rewrites a kept text by itself"],
    ["NoTextBeforeTheMatch", "coach-text: waits for Confirm or Not this one"],
    ["KeptTextIsHonest", "coach-text: says which match a kept review was written for"],
    [
      "OpenAfterModelFailureSpendsNothing",
      "coach-text: tries a text the model failed again only when the athlete asks",
    ],
  ],
  ftp: [
    ["OneFtp", "ftp-proposal: uses only intervals.icu's FTP"],
    ["NeverOverwriteAnUnseenFtp", "ftp-proposal: shows a number set in intervals.icu"],
    ["NoProposalFromOneRide", "ftp-proposal: keeps every rule on every path"],
    ["PlannedTestIsAnswered", "ftp-proposal: answers a planned test within four weeks"],
  ],
  weeks: [
    ["NothingWithoutConsent", "week-delivery: sends nothing before the first Approve"],
    ["ThisWeekAndNextAreThere", "week-delivery: sends every due week after the app was closed"],
  ],
  plan: [
    ["TodayIsKept", "plan-ending: keeps today's workout when the Plan ends"],
    ["NeverTwoPlansOnIntervals", "plan-ending: sends the new Plan's weeks only after the old ones"],
    ["LocalFirst", "plan-ending: closes the Plan locally before any cleanup runs"],
    [
      "YourChangesAreNotDeletedByItself",
      "plan-ending: lists the workouts the athlete changed apart",
    ],
  ],
};

const BREAKS_BEFORE: Readonly<Record<string, readonly string[]>> = {
  "icu/before": [
    "NeverUndoneByItself",
    "KeptEditReplacedOnlyWhenFlagged",
    "CardOnlyForRealChanges",
  ],
  "icu/without-readback": ["CardOnlyForRealChanges", "KeptEditReplacedOnlyWhenFlagged"],
  "icu/without-recheck": ["NeverUndoneByItself"],
  "icu/without-staleSet": ["KeptEditReplacedOnlyWhenFlagged"],
  "outcome/before": ["MissedIsTrue", "RideOnTheDayIsSuggested"],
  "text/before": ["KeptTextIsHonest", "OpenAfterModelFailureSpendsNothing"],
  "ftp/before": ["NeverOverwriteAnUnseenFtp", "PlannedTestIsAnswered"],
  "weeks/before": ["ThisWeekAndNextAreThere"],
  "plan/before": ["TodayIsKept", "NeverTwoPlansOnIntervals", "YourChangesAreNotDeletedByItself"],
};

const CHECKS: readonly Check[] = Object.entries(MODELS).flatMap(([model, definition]) =>
  Object.keys(definition.variants).flatMap((variant) =>
    (RULES[model] ?? []).map(([rule, test]) => ({
      model,
      variant,
      rule,
      test,
      expect: (BREAKS_BEFORE[`${model}/${variant}`] ?? []).includes(rule) ? "breaks" : "holds",
    })),
  ),
);

function parseOptions(argv: readonly string[]): {
  readonly only: string | undefined;
  readonly trace: boolean;
} {
  let only: string | undefined;
  let trace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--model") only = argv[++index];
    else if (argument === "--trace") trace = true;
    else throw new Error(`unknown argument ${argument}; use --model NAME or --trace`);
  }
  return { only, trace };
}

async function tlaTools(): Promise<string> {
  const configured = process.env.TLA2TOOLS;
  const jar =
    configured ??
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "enduragent",
      `tla2tools-${TLC_VERSION}.jar`,
    );
  if (!existsSync(jar)) {
    if (configured !== undefined)
      throw new Error(`TLA2TOOLS points at ${jar}, which does not exist`);
    mkdirSync(dirname(jar), { recursive: true });
    const response = await fetch(TLC_URL);
    if (!response.ok)
      throw new Error(`downloading TLC ${TLC_VERSION} failed: HTTP ${response.status}`);
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (digest !== TLC_SHA256) throw new Error(`${jar} is not TLC ${TLC_VERSION} (sha256 ${digest})`);
  return jar;
}

function javaBinary(): string {
  const java = process.env.JAVA ?? "java";
  if (spawnSync(java, ["-version"], { encoding: "utf8" }).status !== 0) {
    throw new Error(
      `no Java runtime at "${java}"; install Java 11 or newer, or set JAVA to its java binary`,
    );
  }
  return java;
}

function runTlc(
  java: string,
  jar: string,
  workDir: string,
  check: Check,
): { broken: boolean; states: string; output: string } {
  const model = MODELS[check.model];
  if (model === undefined) throw new Error(`no model ${check.model}`);
  const dir = join(workDir, `${check.model}-${check.variant}-${check.rule}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(skillDir, "model", model.dir, `${model.module}.tla`),
    join(dir, `${model.module}.tla`),
  );
  const lines = [
    "CONSTANTS",
    ...(model.variants[check.variant] ?? []).map((line) => `  ${line}`),
    "INIT Init",
    "NEXT Next",
  ];
  if (model.constraint !== undefined) lines.push(`CONSTRAINT ${model.constraint}`);
  lines.push(`INVARIANT ${check.rule}`, "CHECK_DEADLOCK FALSE");
  writeFileSync(join(dir, `${model.module}.cfg`), `${lines.join("\n")}\n`);
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
      `${model.module}.cfg`,
      `${model.module}.tla`,
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  const states = [...output.matchAll(/(\d[\d,]*) distinct states found/g)].at(-1)?.[1] ?? "?";
  if (new RegExp(`Invariant ${check.rule} is violated`).test(output))
    return { broken: true, states, output };
  if (output.includes("Model checking completed. No error has been found."))
    return { broken: false, states, output };
  throw new Error(`TLC did not finish for ${dir}\n${output.slice(-2000)}`);
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
  const workDir = mkdtempSync(join(tmpdir(), "calendar-machines-"));
  const selected = CHECKS.filter(
    (check) => options.only === undefined || check.model === options.only,
  );
  if (selected.length === 0) throw new Error(`no model named ${options.only}`);
  const rows: string[][] = [];
  let mismatches = 0;
  for (const check of selected) {
    const run = runTlc(java, jar, workDir, check);
    const got: Expectation = run.broken ? "breaks" : "holds";
    if (got !== check.expect) mismatches += 1;
    rows.push([
      got === check.expect ? "ok" : "MISMATCH",
      check.model,
      check.variant,
      check.rule,
      check.expect,
      got,
      run.states,
      check.test,
    ]);
    if (options.trace && run.broken)
      process.stdout.write(
        `\n${check.model}/${check.variant} ${check.rule}:\n${traceOf(run.output)}\n`,
      );
  }
  const header = ["", "model", "variant", "rule", "expected", "result", "states", "engine test"];
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
  );
  for (const row of [header, ...rows]) {
    process.stdout.write(
      `${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}\n`,
    );
  }
  rmSync(workDir, { recursive: true, force: true });
  if (mismatches > 0) {
    process.stdout.write(`\n${mismatches} result(s) differ from the expected findings.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nTLC ${TLC_VERSION}: every rule matches its expected result.\n`);
  }
}

await main();
