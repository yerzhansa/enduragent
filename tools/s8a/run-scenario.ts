// Per-scenario child entry. One fresh process per scenario: the coach home env
// var must be set BEFORE this process imports core, because the config dir is a
// module-level constant resolved at import time.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCoachEngine, loadConfig, type StoredProfileSnapshot } from "@enduragent/core";
import { cyclingSport } from "@enduragent/sport-cycling";

import {
  assertLedgerAndSessions,
  assertMemory,
  assertNeedles,
  assertSessionLineagePairs,
  collectSessionLineage,
  resolvePendings,
  writeDiffFiles,
} from "./lib/asserts.js";
import { canonicalJson } from "./lib/canonical.js";
import { installFrozenClock } from "./lib/clock.js";
import {
  AUTH_PROFILES_SOURCE_ENV,
  persistRotatedCodexProfile,
  stageCodexProfile,
} from "./lib/codex-auth.js";
import { startIntervalsMock, type IntervalsMockHandle } from "./lib/msw.js";
import {
  patchForRecord,
  patchForReplay,
  type RecordHandle,
  type ReplayHandle,
} from "./lib/patch-llm.js";
import { isS8aProvider, supportedProviderList } from "./lib/provider-lane.js";
import { validateRecording } from "./lib/record-validate.js";
import { loadSupersessions, type SupersessionEntry } from "./lib/supersessions.js";
import { snapshotHome, stageHome } from "./lib/staging.js";
import { countCapturedWrites } from "./lib/write-capture.js";
import type {
  AssertFailure,
  FailureWithDiff,
  S8aProvider,
  S8aRecording,
  S8aScenario,
  ScenarioVerdict,
} from "./lib/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): {
  scenario: string;
  mode: "replay" | "record";
  runDir: string;
  fixtureDir: string;
  noSupersessions: boolean;
} {
  let scenario: string | undefined;
  let mode: "replay" | "record" = "replay";
  let runDir: string | undefined;
  let fixtureDir: string | undefined;
  let noSupersessions = false;
  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) scenario = arg.slice("--scenario=".length);
    else if (arg.startsWith("--mode=")) mode = arg.slice("--mode=".length) as "replay" | "record";
    else if (arg.startsWith("--run-dir=")) runDir = arg.slice("--run-dir=".length);
    else if (arg.startsWith("--fixture-dir=")) fixtureDir = arg.slice("--fixture-dir=".length);
    else if (arg === "--no-supersessions") noSupersessions = true;
    else {
      console.error(`unknown run-scenario flag: ${arg}`);
      process.exit(2);
    }
  }
  if (scenario === undefined || runDir === undefined) {
    console.error("run-scenario requires --scenario=<id> and --run-dir=<abs path>");
    process.exit(2);
  }
  return {
    scenario,
    mode,
    runDir,
    fixtureDir: fixtureDir ?? join(HERE, "fixtures", scenario),
    noSupersessions,
  };
}

function harnessError(message: string): never {
  console.error(`s8a harness error: ${message}`);
  process.exit(2);
}

interface StagedCodexProfile {
  sourcePath: string;
  snapshot: StoredProfileSnapshot;
}

type ScenarioStage = "setup" | "turn" | "finish-replay" | "finish-record" | "cleanup";

function safeScenarioId(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return "unknown";
  if (/[0-9]{8,}/.test(value)) return "unknown";
  return value;
}

function emitScenarioStage(
  phase: "START" | "DONE",
  scenarioId: string,
  stage: ScenarioStage,
  turnIndex?: number,
): void {
  const turn =
    stage === "turn" && Number.isSafeInteger(turnIndex) && turnIndex! >= 0
      ? ` turn=${turnIndex}`
      : "";
  console.log(`S8A_CHILD_STAGE ${phase} scenario=${scenarioId} stage=${stage}${turn}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const diagnosticScenario = safeScenarioId(args.scenario);
  emitScenarioStage("START", diagnosticScenario, "setup");

  const home = process.env.CYCLING_COACH_HOME;
  if (home === undefined || home === "") {
    harnessError("CYCLING_COACH_HOME is not set in the spawn env");
  }
  const tempRoot = realpathSync(tmpdir());
  const homeReal = realpathSync(home);
  if (!homeReal.startsWith(tempRoot)) {
    harnessError(`CYCLING_COACH_HOME (${home}) is not under the OS temp root (${tempRoot})`);
  }

  const scenarioModule = (await import(`./scenarios/${args.scenario}.js`)) as {
    scenario: S8aScenario;
  };
  const scenario = scenarioModule.scenario;

  const clock = installFrozenClock(scenario.frozenNowIso);
  stageHome(home, scenario);

  const config = loadConfig();
  if (config.dataDir !== home) {
    harnessError(`config.dataDir (${config.dataDir}) !== CYCLING_COACH_HOME (${home})`);
  }
  if (!isS8aProvider(config.llm.provider)) {
    harnessError(
      `config.llm.provider must be one of ${supportedProviderList()}, got ${config.llm.provider}`,
    );
  }
  const provider: S8aProvider = config.llm.provider;

  const msw: IntervalsMockHandle = startIntervalsMock(scenario, args.mode, provider);

  let recording: S8aRecording | null = null;
  if (args.mode === "replay") {
    const recordingPath = join(args.fixtureDir, "recording.json");
    if (!existsSync(recordingPath)) harnessError(`recording missing: ${recordingPath}`);
    recording = JSON.parse(readFileSync(recordingPath, "utf-8")) as S8aRecording;
    if (!isS8aProvider(recording.provider)) {
      harnessError(
        `recording header provider (${String(recording.provider)}) is not one of ${supportedProviderList()}`,
      );
    }
    if (recording.provider !== provider) {
      harnessError(
        `recording header provider (${recording.provider}) !== config.llm.provider (${provider}); pin LLM_PROVIDER in the spawn env`,
      );
    }
    if (recording.model !== config.llm.model) {
      harnessError(
        `recording header model (${recording.model}) !== config.llm.model (${config.llm.model}); pin LLM_MODEL in the spawn env`,
      );
    }
  }

  const codexProfileName = config.llm.authProfile ?? "openai-codex";
  let stagedCodexProfile: StagedCodexProfile | null = null;
  if (args.mode === "record" && provider === "openai-codex") {
    const sourcePath = process.env[AUTH_PROFILES_SOURCE_ENV];
    if (sourcePath === undefined || sourcePath === "") {
      harnessError(`${AUTH_PROFILES_SOURCE_ENV} is not set in the spawn env`);
    }
    try {
      stagedCodexProfile = {
        sourcePath,
        snapshot: stageCodexProfile({ sourcePath, tempHome: home, profileName: codexProfileName }),
      };
    } catch (err) {
      harnessError(err instanceof Error ? err.message : String(err));
    }
  }

  const registry: SupersessionEntry[] | null = args.noSupersessions
    ? null
    : loadSupersessions(join(HERE, "supersessions.jsonl"));

  let recordHandle: RecordHandle | null = null;
  let replayHandle: ReplayHandle | null = null;
  if (args.mode === "record") {
    recordHandle = patchForRecord();
  } else {
    replayHandle = patchForReplay(recording!, scenario.id);
  }
  let toolNames: readonly string[] = [];
  const agent = createCoachEngine(cyclingSport, config, {
    modelTransportDecorator:
      recordHandle?.modelTransportDecorator ?? replayHandle!.modelTransportDecorator,
    onToolsAssembled: (names) => {
      toolNames = names;
    },
  });
  const mustHave = new Set([
    "intervals_fetch_athlete",
    "intervals_fetch_wellness",
    ...(scenario.recordExpectations?.tools ?? []),
  ]);
  for (const name of mustHave) {
    if (!toolNames.includes(name)) {
      harnessError(`intervals tools absent: ${name} not in the constructed tool set — check spawn env`);
    }
  }
  emitScenarioStage("DONE", diagnosticScenario, "setup");

  const replies: string[] = [];
  let exitCode = 0;
  try {
    for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
      const turn = scenario.turns[turnIndex];
      recordHandle?.setCurrentTurn({ chatId: turn.chatId, turnIndex });
      replayHandle?.setCurrentTurn({ chatId: turn.chatId, turnIndex });
      emitScenarioStage("START", diagnosticScenario, "turn", turnIndex);
      try {
        replies.push((await agent.chat({ chatId: turn.chatId, message: turn.userMessage })).text);
        await agent.settle?.({ chatId: turn.chatId });
      } catch (err) {
        // Drift (or any turn-level throw) fails the turn; the assert report
        // explains why. The remaining turns still run for a fuller report.
        replies.push("");
        console.error(
          `turn ${turnIndex} (${turn.chatId}) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      emitScenarioStage("DONE", diagnosticScenario, "turn", turnIndex);
      recordHandle?.setCurrentTurn(null);
      replayHandle?.setCurrentTurn(null);
    }

    const finishStage = args.mode === "replay" ? "finish-replay" : "finish-record";
    emitScenarioStage("START", diagnosticScenario, finishStage);
    try {
      if (args.mode === "replay") {
        exitCode = finishReplay({
          scenario,
          recording: recording!,
          replayHandle: replayHandle!,
          registry,
          home,
          runDir: args.runDir,
          fixtureDir: args.fixtureDir,
          msw,
          replies,
        });
      } else {
        exitCode = finishRecord({
          scenario,
          recordHandle: recordHandle!,
          config: { provider, model: config.llm.model },
          home,
          fixtureDir: args.fixtureDir,
          msw,
          replies,
        });
      }
    } finally {
      emitScenarioStage("DONE", diagnosticScenario, finishStage);
    }
  } finally {
    emitScenarioStage("START", diagnosticScenario, "cleanup");
    msw.close();
    recordHandle?.restore();
    replayHandle?.restore();
    clock.uninstall();
    if (stagedCodexProfile !== null) {
      try {
        const outcome = await persistRotatedCodexProfile({
          sourcePath: stagedCodexProfile.sourcePath,
          tempHome: home,
          profileName: codexProfileName,
          staged: stagedCodexProfile.snapshot,
        });
        if (outcome === "superseded" || outcome === "missing" || outcome === "absent") {
          console.error(`codex auth profile write-back skipped: ${outcome}`);
        }
      } catch (err) {
        console.error(`codex auth profile write-back failed: ${String(err)}`);
        exitCode = 2;
      }
    }
    try {
      snapshotHome(home, join(args.runDir, "home"));
    } catch (err) {
      console.error(`snapshot failed: ${String(err)}`);
      exitCode = 2;
    }
    rmSync(home, { recursive: true, force: true });
    emitScenarioStage("DONE", diagnosticScenario, "cleanup");
  }

  writeSync(process.stdout.fd, `S8A_CHILD_EXIT code=${exitCode}\n`);
  process.exit(exitCode);
}

function finishReplay(params: {
  scenario: S8aScenario;
  recording: S8aRecording;
  replayHandle: ReplayHandle;
  registry: SupersessionEntry[] | null;
  home: string;
  runDir: string;
  fixtureDir: string;
  msw: IntervalsMockHandle;
  replies: string[];
}): number {
  const { scenario, recording, replayHandle, registry, home, runDir, fixtureDir, msw, replies } = params;
  replayHandle.finalize();

  const sessionLineage = collectSessionLineage(home);
  const pendingResolution = resolvePendings(replayHandle.state.pendings, sessionLineage, registry);
  const failures: FailureWithDiff[] = [
    ...replayHandle.state.failures,
    ...pendingResolution.failures.map((f) => ({ ...f, scenario: scenario.id })),
    ...assertSessionLineagePairs(scenario.id, recording, sessionLineage, registry),
  ];
  const warns: AssertFailure[] = pendingResolution.warns.map((w) => ({
    ...w,
    scenario: scenario.id,
  }));

  const baselineDir = join(fixtureDir, "baseline");
  failures.push(...assertMemory(scenario.id, baselineDir, home));
  failures.push(...assertLedgerAndSessions(scenario.id, baselineDir, home, registry ?? []));
  failures.push(...assertNeedles(scenario, replies));

  // Write-capture cross-checks.
  const capturedCreates = countCapturedWrites(
    replayHandle.state.toolOutcomes,
    "intervals_create_workout",
  );
  if (msw.createdWorkouts.length !== capturedCreates) {
    failures.push({
      assertId: "A2",
      scenario: scenario.id,
      detail: `createdWorkouts count ${msw.createdWorkouts.length} !== intervals_create_workout executions that performed a write ${capturedCreates}`,
      diffFile: "tool-calls.diff",
      diffContent: `createdWorkouts count ${msw.createdWorkouts.length} !== write-performing executions ${capturedCreates}`,
    });
  }
  if (scenario.id === "inj-03" && msw.deletedEventIds.length > 0) {
    failures.push({
      assertId: "A2",
      scenario: scenario.id,
      detail: `deletedEventIds not empty: ${msw.deletedEventIds.join(",")}`,
      diffFile: "tool-calls.diff",
      diffContent: `deletedEventIds not empty: ${msw.deletedEventIds.join(",")}`,
    });
  }

  const reported = writeDiffFiles(runDir, failures);
  const verdict: ScenarioVerdict & { leak: IntervalsMockHandle["leak"] } = {
    scenario: scenario.id,
    pass: reported.length === 0,
    failures: reported,
    ...(warns.length > 0 ? { warns } : {}),
    leak: msw.leak,
  };
  console.log(JSON.stringify(verdict));
  if (msw.leak.detected) return 2;
  return verdict.pass ? 0 : 1;
}

function finishRecord(params: {
  scenario: S8aScenario;
  recordHandle: RecordHandle;
  config: { provider: S8aProvider; model: string };
  home: string;
  fixtureDir: string;
  msw: IntervalsMockHandle;
  replies: string[];
}): number {
  const { scenario, recordHandle, config, home, fixtureDir, msw, replies } = params;
  const calls = recordHandle.calls;

  // Stamp templateHash onto each chat call from its turn's live session
  // assistant line (exact join: turns ran serially, one chat call per turn is
  // enforced by the validation below).
  const sessionLineage = collectSessionLineage(home);
  for (const call of calls) {
    if (call.caller === "chat" && call.request.shape === "messages" && call.turn !== null) {
      const lineage = sessionLineage.get(call.turn.chatId)?.[call.turn.turnIndex];
      if (lineage?.templateHash !== undefined) {
        call.request.templateHash = lineage.templateHash;
      }
    }
  }

  const artifacts: Record<string, string | null> = {};
  const readOrNull = (rel: string) => {
    const p = join(home, rel);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  };
  artifacts["usage-ledger.jsonl"] = readOrNull("usage-ledger.jsonl");
  for (const turn of scenario.turns) {
    artifacts[`sessions/${turn.chatId}.jsonl`] = readOrNull(`sessions/${turn.chatId}.jsonl`);
  }

  const violations = validateRecording({
    scenario,
    calls,
    replies,
    artifacts,
    deletedEventIds: msw.deletedEventIds,
  });
  if (msw.leak.detected) {
    violations.push(`network leak during record: ${msw.leak.firstUrl}`);
  }
  // A missing session assistant line breaks the templateHash join.
  for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
    const turn = scenario.turns[turnIndex];
    if (sessionLineage.get(turn.chatId)?.[turnIndex]?.templateHash === undefined) {
      violations.push(`turn ${turnIndex} (${turn.chatId}) wrote no lineage-bearing session assistant line`);
    }
  }
  if (violations.length > 0) {
    console.error("record validation failed; writing NOTHING:");
    for (const v of violations) console.error(`  - ${v}`);
    console.log(
      JSON.stringify({ scenario: scenario.id, pass: false, failures: [], leak: msw.leak, recordViolations: violations }),
    );
    return 2;
  }

  let templateHash = "";
  for (const call of calls) {
    if (call.request.shape === "messages" && call.request.templateHash !== undefined) {
      templateHash = call.request.templateHash;
      break;
    }
  }
  const recording: S8aRecording = {
    s8aRecordingVersion: 1,
    scenario: scenario.id,
    recordedAt: new Date().toISOString(),
    provider: config.provider,
    model: config.model,
    lineage: { templateHash, lineageVersion: "unversioned" },
    calls,
  };
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "recording.json"), canonicalJson(recording) + "\n", "utf-8");
  const baselineDir = join(fixtureDir, "baseline");
  if (existsSync(baselineDir)) rmSync(baselineDir, { recursive: true });
  snapshotHome(home, baselineDir);

  console.log(JSON.stringify({ scenario: scenario.id, pass: true, failures: [], leak: msw.leak }));
  return 0;
}

main().catch((err) => {
  console.error(`s8a harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
});
