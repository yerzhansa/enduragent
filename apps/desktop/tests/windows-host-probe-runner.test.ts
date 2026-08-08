import { describe, expect, it, vi } from "vitest";

import {
  PROBE_RUNNER_EXPECTED_WORK_COUNT,
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
  ProbeRunnerError,
  deriveProbeRunPlan,
  deriveProbeWorkUpstreamSelectionDigests,
  dispatchAuthoritativeProbeCommand,
  extractProbeDependencySelection,
  getProbeRunWorkItem,
  parseAuthoritativeProbeCommand,
  validateAuthoritativeProbeCommand,
  validateProbeRunPlan,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import type { VerifiedProbeCampaignResult } from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import type {
  AuthoritativeProbeRunnerCommand,
  ProbeRunnerContinuationCommand,
  ProbeRunnerFinalizeCampaignCommand,
  ProbeRunnerFinalizeSegmentCommand,
  ProbeRunnerPrepareCommand,
  ProbeRunnerSegmentCommand,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";

const commonFlags = [
  "--mode=authoritative",
  "--campaign-run-id=campaign-run-one",
  `--plan-sha256=${PROBE_RUN_PLAN_SHA256}`,
];

function coordinateFlags(rowId: string, variantId: string) {
  return [
    "--attempt-id=attempt-one",
    "--environment-id=win11-floor",
    "--path-profile-id=ascii",
    `--row-id=${rowId}`,
    `--variant-id=${variantId}`,
  ];
}

function commandFlags(command: string, extra: readonly string[]) {
  return [...commonFlags, `--command=${command}`, ...extra];
}

function ordinarySegmentCommand() {
  return parseAuthoritativeProbeCommand(
    commandFlags("segment", coordinateFlags("F-01", "f01-ordinary-absolute-path")),
  ) as ProbeRunnerSegmentCommand;
}

function hardCutCommand(command: "checkpoint" | "resume", repetition = 1) {
  return parseAuthoritativeProbeCommand(
    commandFlags(command, [
      ...coordinateFlags("F-07", "f07-hard-cut-after-file-flush"),
      `--repetition=${repetition}`,
    ]),
  ) as ProbeRunnerContinuationCommand;
}

function completeDependencyRow(rowId: string, selectionDigest: string) {
  return {
    rowId,
    claim: "synthetic contract fixture",
    stopCondition: "synthetic contract fixture",
    status: "PASS",
    stopConditionTriggered: false,
    selectedMechanism: "synthetic-mechanism",
    mechanismDefinitionSha256: "d".repeat(64),
    verifierBindings: [],
    verificationInputSha256: "e".repeat(64),
    rowEvidenceSha256: "f".repeat(64),
    upstreamSelectionDigests: [],
    selectionDigest,
    blockedByRowIds: [],
    environmentEvidenceRefs: [],
    expectedSegmentCount: 1,
    observedSegmentCount: 1,
    missingSegments: [],
    inconclusiveSegments: [],
    skippedConditionalSegments: [],
    rowClosureClaimed: false,
  };
}

function verifiedPrefixResult(
  rowResults: readonly Readonly<Record<string, unknown>>[],
): VerifiedProbeCampaignResult {
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-campaign-result",
    authority: "verified-artifact-finalizer",
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_RUN_PLAN.manifestSha256,
    candidateSha256: "a".repeat(64),
    phase: "probe",
    status: "INCONCLUSIVE",
    selectionEligible: false,
    rowClosureClaimed: false,
    issues: [],
    rowResults,
    analysisSha256: "b".repeat(64),
    verifiedSegmentDigests: [],
    campaignResultSha256: "c".repeat(64),
  };
}

describe("authoritative Windows host probe runner", () => {
  it("derives the immutable 1,044-work plan in six dependency stages", () => {
    expect(PROBE_RUNNER_EXPECTED_WORK_COUNT).toBe(1044);
    expect(PROBE_RUN_PLAN).toMatchObject({
      workCount: 1044,
      conditionalWorkCount: 28,
      hardCutWorkCount: 16,
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(PROBE_RUN_PLAN.stages.map((stage) => stage.rowIds)).toEqual([
      ["F-01", "F-09"],
      ["F-02", "F-08"],
      ["F-03"],
      ["F-04", "F-05"],
      ["F-06"],
      ["F-07", "F-10"],
    ]);
    expect(PROBE_RUN_PLAN.stages.map((stage) => stage.workCount)).toEqual([
      140, 184, 128, 192, 240, 160,
    ]);
    expect(PROBE_RUN_PLAN.stages.map((stage) => stage.dependencyStageIndexes)).toEqual([
      [],
      [0],
      [1],
      [2],
      [2, 3],
      [0, 1, 2, 3, 4],
    ]);
    expect(PROBE_RUN_PLAN.work.map((item) => item.ordinal)).toEqual(
      Array.from({ length: 1044 }, (_, index) => index + 1),
    );
    expect(new Set(PROBE_RUN_PLAN.work.map((item) => item.workId))).toHaveLength(1044);
    expect(Object.isFrozen(PROBE_RUN_PLAN)).toBe(true);
    expect(Object.isFrozen(PROBE_RUN_PLAN.work)).toBe(true);
    expect(deriveProbeRunPlan()).toEqual(PROBE_RUN_PLAN);
    expect(validateProbeRunPlan(PROBE_RUN_PLAN)).toBe(PROBE_RUN_PLAN);
  });

  it("retains every conditional skip coordinate and trusted verifier mapping", () => {
    const conditional = PROBE_RUN_PLAN.work.filter((item) => item.availability === "conditional");
    expect(conditional).toHaveLength(28);
    expect(conditional.every((item) => item.conditionId !== null)).toBe(true);
    expect(new Set(conditional.map((item) => item.variantId))).toHaveLength(7);
    expect(conditional.some((item) => item.variantId === "f01-mapped-network-drive-refusal")).toBe(
      true,
    );
    expect(conditional.some((item) => item.variantId === "f03-vault-symlink")).toBe(true);
    expect(
      PROBE_RUN_PLAN.work.every(
        (item) =>
          /^[a-f0-9]{64}$/u.test(item.verifierDefinitionSha256) &&
          /^[a-f0-9]{64}$/u.test(item.transcriptMappingSha256) &&
          item.transcriptCommandIds.length > 0,
      ),
    ).toBe(true);
  });

  it("looks up only exact environment/path/row/variant coordinates", () => {
    const item = getProbeRunWorkItem({
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F-07",
      variantId: "f07-hard-cut-after-file-flush",
    });
    expect(item).toMatchObject({
      stageIndex: 5,
      continuationRepetitions: 5,
      requiresExternalCheckpoint: true,
    });
    expect(() =>
      getProbeRunWorkItem({
        environmentId: "win11-floor",
        pathProfileId: "ascii",
        rowId: "F-07",
        variantId: "f07-not-real",
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_COORDINATE" }));
  });

  it("extracts only complete PASS dependency rows from a verified campaign prefix", () => {
    const firstSelectionDigest = "1".repeat(64);
    const result = verifiedPrefixResult([completeDependencyRow("F-01", firstSelectionDigest)]);
    expect(extractProbeDependencySelection(result, "F-01")).toEqual({
      rowId: "F-01",
      selectionDigest: firstSelectionDigest,
    });
    expect(
      deriveProbeWorkUpstreamSelectionDigests(
        result,
        getProbeRunWorkItem({
          environmentId: "win11-floor",
          pathProfileId: "ascii",
          rowId: "F-02",
          variantId: "f02-create-private-directory",
        }),
      ),
    ).toEqual([firstSelectionDigest]);

    expect(() =>
      extractProbeDependencySelection(
        verifiedPrefixResult([
          { ...completeDependencyRow("F-01", firstSelectionDigest), observedSegmentCount: 0 },
        ]),
        "F-01",
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_SELECTION_INCOMPLETE" }));
    expect(() =>
      extractProbeDependencySelection(
        verifiedPrefixResult([
          { ...completeDependencyRow("F-01", firstSelectionDigest), status: "FAIL" },
        ]),
        "F-01",
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_SELECTION_INCOMPLETE" }));
    expect(() =>
      extractProbeDependencySelection(
        {
          ...result,
          issues: [{ code: "synthetic-issue" }],
        },
        "F-01",
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_SELECTION_ISSUES" }));
  });

  it("parses immutable prepare and segment commands from exact flags", () => {
    const prepare = parseAuthoritativeProbeCommand(
      commandFlags("prepare", [
        "--execution-run-id=execution-one",
        "--execution-bundle-id=bundle-one",
        "--attempt-id=attempt-one",
        "--environment-id=win11-floor",
        "--path-profile-id=ascii",
      ]),
    ) as ProbeRunnerPrepareCommand;
    expect(prepare).toMatchObject({
      command: "prepare",
      preparationId: "prepare-win11-floor-ascii",
      executionRunId: "execution-one",
      executionBundleId: "bundle-one",
    });
    expect(Object.isFrozen(prepare)).toBe(true);

    const flags = commandFlags("segment", coordinateFlags("F-01", "f01-ordinary-absolute-path"));
    const segment = parseAuthoritativeProbeCommand(flags) as ProbeRunnerSegmentCommand;
    expect(segment).toMatchObject({
      command: "segment",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      stageIndex: 0,
      workId: expect.stringMatching(/^work-\d{4}$/u),
    });
    expect(parseAuthoritativeProbeCommand([...flags].reverse())).toEqual(segment);
    expect(validateAuthoritativeProbeCommand(segment)).toBe(segment);
  });

  it("derives checkpoint and resume identities without accepting controller-selected chains", () => {
    const checkpoint = hardCutCommand("checkpoint", 3);
    const resume = hardCutCommand("resume", 3);
    expect(checkpoint).toMatchObject({
      checkpointId: "checkpoint-3",
      repetition: 3,
      chainId: expect.stringMatching(/^chain-[a-f0-9]{32}$/u),
    });
    expect(resume.chainId).toBe(checkpoint.chainId);
    expect(() =>
      parseAuthoritativeProbeCommand(
        commandFlags("checkpoint", [
          ...coordinateFlags("F-01", "f01-ordinary-absolute-path"),
          "--repetition=1",
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_CHECKPOINT_COORDINATE" }));
    expect(() => hardCutCommand("resume", 6)).toThrowError(
      expect.objectContaining({ code: "RUNNER_INTEGER" }),
    );
  });

  it("parses distinct segment and campaign finalization commands", () => {
    const segment = parseAuthoritativeProbeCommand(
      commandFlags("finalize", [
        "--scope=segment",
        ...coordinateFlags("F-01", "f01-ordinary-absolute-path"),
      ]),
    ) as ProbeRunnerFinalizeSegmentCommand;
    const campaign = parseAuthoritativeProbeCommand(
      commandFlags("finalize", ["--scope=campaign"]),
    ) as ProbeRunnerFinalizeCampaignCommand;
    expect(segment).toMatchObject({ command: "finalize", scope: "segment", stageIndex: 0 });
    expect(campaign).toEqual({
      schemaVersion: 1,
      kind: "windows-host-probe-runner-command",
      mode: "authoritative",
      command: "finalize",
      campaignRunId: "campaign-run-one",
      planSha256: PROBE_RUN_PLAN_SHA256,
      scope: "campaign",
    });
  });

  it("refuses argument ambiguity, scenario injection, and plan drift", () => {
    const valid = commandFlags("segment", coordinateFlags("F-01", "f01-ordinary-absolute-path"));
    for (const extra of [
      "--outcome=PASS",
      "--raw-facts=forged",
      "--command-ids=forged",
      "--upstream-selection-digests=forged",
    ]) {
      expect(() => parseAuthoritativeProbeCommand([...valid, extra])).toThrowError(
        expect.objectContaining({ code: "RUNNER_ARGUMENT_UNKNOWN" }),
      );
    }
    expect(() => parseAuthoritativeProbeCommand([...valid, "--row-id=F-01"])).toThrowError(
      expect.objectContaining({ code: "RUNNER_ARGUMENT_DUPLICATE" }),
    );
    expect(() =>
      parseAuthoritativeProbeCommand(
        valid.map((flag) =>
          flag.startsWith("--plan-sha256=") ? `--plan-sha256=${"0".repeat(64)}` : flag,
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_PLAN_BINDING" }));
    expect(() => validateProbeRunPlan({ ...PROBE_RUN_PLAN, workCount: 1043 })).toThrowError(
      expect.objectContaining({ code: "RUNNER_PLAN_DIGEST" }),
    );
    expect(() =>
      validateAuthoritativeProbeCommand({ ...ordinarySegmentCommand(), workId: "work-9999" }),
    ).toThrowError(expect.objectContaining({ code: "RUNNER_COORDINATE_BINDING" }));
  });

  it("dispatches lifecycle and finalization commands only through injected interfaces", async () => {
    const prepare = parseAuthoritativeProbeCommand(
      commandFlags("prepare", [
        "--execution-run-id=execution-one",
        "--execution-bundle-id=bundle-one",
        "--attempt-id=attempt-one",
        "--environment-id=win11-floor",
        "--path-profile-id=ascii",
      ]),
    ) as ProbeRunnerPrepareCommand;
    const segment = ordinarySegmentCommand();
    const checkpoint = hardCutCommand("checkpoint");
    const resume = hardCutCommand("resume");
    const finalizeSegment = parseAuthoritativeProbeCommand(
      commandFlags("finalize", [
        "--scope=segment",
        ...coordinateFlags("F-01", "f01-ordinary-absolute-path"),
      ]),
    ) as ProbeRunnerFinalizeSegmentCommand;
    const finalizeCampaign = parseAuthoritativeProbeCommand(
      commandFlags("finalize", ["--scope=campaign"]),
    ) as ProbeRunnerFinalizeCampaignCommand;
    const calls: AuthoritativeProbeRunnerCommand[] = [];
    const capture = vi.fn(
      async ({ command }: { readonly command: AuthoritativeProbeRunnerCommand }) => {
        calls.push(command);
        return command.command;
      },
    );
    const dispatchers = {
      prepare: capture,
      segment: capture,
      checkpoint: capture,
      resume: capture,
      finalizeSegment: capture,
      finalizeCampaign: capture,
    };
    for (const command of [
      prepare,
      segment,
      checkpoint,
      resume,
      finalizeSegment,
      finalizeCampaign,
    ]) {
      await expect(dispatchAuthoritativeProbeCommand(command, dispatchers)).resolves.toBe(
        command.command,
      );
    }
    expect(calls).toEqual([
      prepare,
      segment,
      checkpoint,
      resume,
      finalizeSegment,
      finalizeCampaign,
    ]);
    await expect(dispatchAuthoritativeProbeCommand(segment)).rejects.toMatchObject({
      code: "RUNNER_DISPATCHER_MISSING",
    });
    expect(capture).toHaveBeenCalledTimes(6);
  });

  it("exposes a typed runner error without lab-result defaults", () => {
    const error = new ProbeRunnerError("SYNTHETIC", "synthetic runner error");
    expect(error).toMatchObject({ name: "ProbeRunnerError", code: "SYNTHETIC" });
    expect(PROBE_RUN_PLAN.work.some((item) => Object.hasOwn(item, "outcome"))).toBe(false);
    expect(PROBE_RUN_PLAN.work.some((item) => Object.hasOwn(item, "rawFacts"))).toBe(false);
  });
});
