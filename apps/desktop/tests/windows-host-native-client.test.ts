import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_COMMANDS,
  NATIVE_CHILD_ENV_ALLOWLIST,
  NATIVE_PROTOCOL_VERSION,
  NativeClientError,
  buildNativeToolEnvironment,
  buildNativeChildEnvironment,
  buildNativeHelper,
  createNativeChannelApi,
  describePrivateDirectoryCreationFailure,
  invokeNative,
  loadNativeHelper,
  openNativeChannel,
  resolveNativeCandidateArtifactPath,
  resolveNativeWindowsToolPaths,
  validateNativeCommandResult,
  validateNativeCommandTranscript,
  validateNativeEvidenceSeal,
} from "../scripts/windows-host-falsifier/native-client.mjs";
import type {
  NativeBuild,
  NativeChannelTransport,
  NativeCommandTranscript,
  NativePreflightBinding,
  NativePreparedFrameTransmission,
  NativeRequestMap,
} from "../scripts/windows-host-falsifier/native-client.mjs";

const candidateSha256 = "a".repeat(64);
const roots: string[] = [];
const syntheticWindowsSystemLibraries = [
  "C:\\Windows\\System32\\KERNEL32.DLL",
  "C:\\Windows\\System32\\ntdll.dll",
] as const;
const duplicatePrivateDirectoryAclPowerShell = String.raw`$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_ACL_TEST_PATH')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = 'O:' + $sid + 'D:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
$binary = [byte[]]::new($descriptor.BinaryLength)
$descriptor.GetBinaryForm($binary, 0)
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetSecurityDescriptorBinaryForm($binary)
$directory = [IO.DirectoryInfo]::new($path)
$directory.SetAccessControl($security)
$actual = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
$actualRaw = [Security.AccessControl.RawSecurityDescriptor]::new($actual.GetSecurityDescriptorBinaryForm(), 0)
$currentUserCount = 0
foreach ($ace in $actualRaw.DiscretionaryAcl) {
  if ($ace.SecurityIdentifier.Value -ceq $sid) { $currentUserCount += 1 }
}
if (!$actual.AreAccessRulesProtected -or $actualRaw.DiscretionaryAcl.Count -ne 4 -or $currentUserCount -ne 2) { exit 45 }`;
const callbackPrivateDirectoryAclPowerShell = String.raw`$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_ACL_TEST_PATH')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = 'O:' + $sid + 'D:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
$ordinary = $descriptor.DiscretionaryAcl[0] -as [Security.AccessControl.CommonAce]
$callback = [Security.AccessControl.CommonAce]::new($ordinary.AceFlags, $ordinary.AceQualifier, $ordinary.AccessMask, $ordinary.SecurityIdentifier, $true, [byte[]]::new(0))
$descriptor.DiscretionaryAcl.RemoveAce(0)
$descriptor.DiscretionaryAcl.InsertAce(0, $callback)
$binary = [byte[]]::new($descriptor.BinaryLength)
$descriptor.GetBinaryForm($binary, 0)
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetSecurityDescriptorBinaryForm($binary)
$directory = [IO.DirectoryInfo]::new($path)
$directory.SetAccessControl($security)
$actual = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
$actualRaw = [Security.AccessControl.RawSecurityDescriptor]::new($actual.GetSecurityDescriptorBinaryForm(), 0)
$callbackCount = 0
foreach ($genericAce in $actualRaw.DiscretionaryAcl) {
  $commonAce = $genericAce -as [Security.AccessControl.CommonAce]
  if ($null -ne $commonAce -and $commonAce.IsCallback -and $commonAce.AceType -eq [Security.AccessControl.AceType]::AccessAllowedCallback -and $commonAce.SecurityIdentifier.Value -ceq $sid -and $commonAce.AccessMask -eq 0x001F01FF -and $commonAce.AceFlags -eq ([Security.AccessControl.AceFlags]::ContainerInherit -bor [Security.AccessControl.AceFlags]::ObjectInherit)) { $callbackCount += 1 }
}
if (!$actual.AreAccessRulesProtected -or $actualRaw.DiscretionaryAcl.Count -ne 3 -or $callbackCount -ne 1) { exit 46 }`;

function preflightBinding(
  nativeHelperSha256: string,
  evidenceRootObjectIdentitySha256 = "0".repeat(64),
  nativeHelperArtifactPath = "bin/windows-host-falsifier-native.exe",
  nativeCandidateDigest = "e".repeat(64),
  nativeManifestSha256 = "f".repeat(64),
): NativePreflightBinding {
  return {
    campaignRunId: "campaign-regression",
    candidateSha256,
    preflightSha256: "b".repeat(64),
    executionBundleManifestSha256: "c".repeat(64),
    nativeHelperArtifactPath,
    nativeHelperSha256,
    nativeCandidateDigest,
    nativeManifestSha256,
    evidenceRootObjectIdentitySha256,
  };
}

function nativeBuildFixture(): NativeBuild {
  return {
    candidateDigest: "e".repeat(64),
    assemblySha256: "d".repeat(64),
    sourceBundleSha256: "1".repeat(64),
    toolchainDigest: "2".repeat(64),
    manifestSha256: "f".repeat(64),
    sources: [],
    toolchain: {},
    assemblyPath: "/candidate/native/windows-host-falsifier-native.exe",
    buildDirectory: "/candidate/build",
    candidateRoot: "/candidate",
    candidateDirectory: "/candidate/native",
    nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
    snapshotDirectory: "/candidate/snapshot",
    manifestPath: "/candidate/native-manifest.json",
  };
}

function preparedChannel(
  runRoot: string,
  sendPrepared: (prepared: NativePreparedFrameTransmission) => Promise<
    | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly win32Code: number | null;
        };
      }
  >,
) {
  const build = nativeBuildFixture();
  const transport = {
    nativeSessionId: "native-prepared-test",
    closed: false,
    exit: Promise.resolve({ code: 0, signal: null }),
    sendPrepared,
    send: async () => {
      throw new Error("session control is not available in the prepared-channel fixture");
    },
    nextEvent: async () => null,
    snapshotTranscript: () => {
      throw new Error("transcript is not available in the prepared-channel fixture");
    },
    finish: async () => ({ code: 0, signal: null }),
    terminateExpected: async () => ({ code: null, signal: "SIGTERM" }),
  } as unknown as NativeChannelTransport;
  return createNativeChannelApi({
    build,
    transport,
    runRoot,
    preflightBinding: preflightBinding(build.assemblySha256),
  });
}

function framedDigest(...fields: readonly string[]) {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object") throw new Error("test fixture is not JSON");
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .map((key) => [key, canonicalJson(record[key])]),
  );
}

function canonicalDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function hexProjection(value: string) {
  return createHash("sha256").update(Buffer.from(value, "hex")).digest("hex");
}

function nativeTranscriptFixture({
  requestDigestTampered = false,
  responseDigestTampered = false,
  eventDigestTampered = false,
  transcriptDigestTampered = false,
  eventSessionId = "ns-owner",
  eventRecordSequence = 2,
  controlSessionId = "ns-owner",
  resultExtraField = false,
  ownerCommandFailed = false,
  rawPipeSecretsRetained = false,
  rootIdentityDigestTampered = false,
  startupHandshakeTampered = false,
  nativeCandidateDigest = "e".repeat(64),
  nativeManifestSha256 = "f".repeat(64),
} = {}) {
  const runRootIdentity = "volume-v1:root-v1";
  const bindingFields = {
    ...preflightBinding(
      "d".repeat(64),
      rootIdentityDigestTampered
        ? "0".repeat(64)
        : createHash("sha256").update(runRootIdentity, "utf8").digest("hex"),
      "bin/windows-host-falsifier-native.exe",
      nativeCandidateDigest,
      nativeManifestSha256,
    ),
    nativeSessionId: "native-session",
    runRootIdentity,
  };
  const startupOperationId = "op-startup";
  const startupRequestId = "req-startup";
  const startupRequestContext = {
    campaignRunId: bindingFields.campaignRunId,
    candidateSha256: bindingFields.candidateSha256,
    preflightSha256: bindingFields.preflightSha256,
    executionBundleManifestSha256: bindingFields.executionBundleManifestSha256,
    nativeCandidateDigest: bindingFields.nativeCandidateDigest,
    nativeManifestSha256: bindingFields.nativeManifestSha256,
    nativeHelperSha256: bindingFields.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: bindingFields.evidenceRootObjectIdentitySha256,
    nativeSessionId: bindingFields.nativeSessionId,
    operationId: startupOperationId,
  };
  const startupRequestFrameSha256 = canonicalDigest({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId: startupRequestId,
    command: "native-binding-check",
    context: startupRequestContext,
    request: {},
  });
  const startupHandshake = {
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    kind: "response",
    requestId: startupRequestId,
    command: "native-binding-check",
    context: {
      ...startupRequestContext,
      requestFrameSha256: startupRequestFrameSha256,
      runRootIdentity,
    },
    ok: true,
    result: {
      ready: true,
      processId: 1234,
      nativeHelperSha256: bindingFields.nativeHelperSha256,
      runRootIdentity,
      evidenceRootObjectIdentitySha256: bindingFields.evidenceRootObjectIdentitySha256,
    },
  };
  const binding = {
    ...bindingFields,
    startupHandshake: startupHandshakeTampered
      ? {
          ...startupHandshake,
          context: { ...startupHandshake.context, requestFrameSha256: "1".repeat(64) },
        }
      : startupHandshake,
    startupHandshakeSha256: canonicalDigest(startupHandshake),
  };
  const operationId = "op-owner";
  const requestId = "req-owner";
  const rawRequest = {
    pipeName:
      "\\\\.\\pipe\\Enduragent-upgrade-v1-ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
    capabilityHex: "2".repeat(64),
    bindingHex: "3".repeat(64),
    maxFrameBytes: 4096,
    connectDeadlineMs: 5000,
    readDeadlineMs: 5000,
  };
  const request = rawPipeSecretsRetained
    ? rawRequest
    : {
        pipeName: rawRequest.pipeName,
        capabilitySha256: hexProjection(rawRequest.capabilityHex),
        bindingSha256: hexProjection(rawRequest.bindingHex),
        maxFrameBytes: rawRequest.maxFrameBytes,
        connectDeadlineMs: rawRequest.connectDeadlineMs,
        readDeadlineMs: rawRequest.readDeadlineMs,
      };
  const requestContext = {
    campaignRunId: binding.campaignRunId,
    candidateSha256: binding.candidateSha256,
    preflightSha256: binding.preflightSha256,
    executionBundleManifestSha256: binding.executionBundleManifestSha256,
    nativeCandidateDigest: binding.nativeCandidateDigest,
    nativeManifestSha256: binding.nativeManifestSha256,
    nativeHelperSha256: binding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: binding.evidenceRootObjectIdentitySha256,
    nativeSessionId: binding.nativeSessionId,
    operationId,
  };
  const ownerRequestFrameSha256 = canonicalDigest({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId,
    command: "pipe-owner",
    context: requestContext,
    request: rawRequest,
  });
  const responseContext = {
    ...requestContext,
    requestFrameSha256: ownerRequestFrameSha256,
    runRootIdentity: binding.runRootIdentity,
  };
  const eventContext = { ...requestContext, runRootIdentity: binding.runRootIdentity };
  const result = {
    sessionId: "ns-owner",
    state: "ready",
    ownerSidSha256: "4".repeat(64),
    pipeNameSha256: "5".repeat(64),
    ...(resultExtraField ? { extra: true } : {}),
  };
  const responsePayload = ownerCommandFailed
    ? { error: { code: "OWNER_FAILED", message: "owner failed", win32Code: 5 } }
    : { result };
  const commandRecord = {
    kind: "command",
    sequence: 1,
    requestId,
    command: "pipe-owner",
    operationId,
    requestFrameSha256: requestDigestTampered ? "6".repeat(64) : ownerRequestFrameSha256,
    nativeRequestFrameSha256: ownerRequestFrameSha256,
    requestFrameVerification: "native-receipt",
    responseFrameSha256: responseDigestTampered
      ? "7".repeat(64)
      : canonicalDigest({
          protocolVersion: 1,
          kind: "response",
          requestId,
          command: "pipe-owner",
          context: responseContext,
          ok: !ownerCommandFailed,
          ...responsePayload,
        }),
    ok: !ownerCommandFailed,
    request,
    ...responsePayload,
  };
  const eventData = { pipeNameSha256: result.pipeNameSha256 };
  const eventRecord = {
    kind: "event",
    sequence: eventRecordSequence,
    resourceSessionId: eventSessionId,
    resourceCommand: "pipe-owner",
    operationId,
    event: "ready",
    eventSequence: 1,
    eventFrameSha256: eventDigestTampered
      ? "8".repeat(64)
      : canonicalDigest({
          protocolVersion: 1,
          kind: "event",
          sessionId: eventSessionId,
          context: eventContext,
          sequence: 1,
          event: "ready",
          data: eventData,
        }),
    data: eventData,
  };
  const controlOperationId = "op-control";
  const controlRequestId = "req-control";
  const controlRequest = { sessionId: controlSessionId, action: "query" };
  const controlRequestContext = {
    ...requestContext,
    operationId: controlOperationId,
  };
  const controlResponseContext = {
    ...controlRequestContext,
    requestFrameSha256: canonicalDigest({
      protocolVersion: 1,
      requestId: controlRequestId,
      command: "session-control",
      context: controlRequestContext,
      request: controlRequest,
    }),
    runRootIdentity: binding.runRootIdentity,
  };
  const controlResult = {
    sessionId: controlSessionId,
    state: "ready",
    capabilityConsumed: false,
  };
  const controlRecord = {
    kind: "command",
    sequence: 3,
    requestId: controlRequestId,
    command: "session-control",
    operationId: controlOperationId,
    requestFrameSha256: controlResponseContext.requestFrameSha256,
    nativeRequestFrameSha256: controlResponseContext.requestFrameSha256,
    requestFrameVerification: "recomputed",
    responseFrameSha256: canonicalDigest({
      protocolVersion: 1,
      kind: "response",
      requestId: controlRequestId,
      command: "session-control",
      context: controlResponseContext,
      ok: true,
      result: controlResult,
    }),
    ok: true,
    request: controlRequest,
    result: controlResult,
  };
  const payload = {
    schemaVersion: 1,
    kind: "windows-host-native-command-transcript",
    binding,
    records: ownerCommandFailed
      ? [commandRecord, eventRecord]
      : [commandRecord, eventRecord, controlRecord],
    termination: { mode: "clean-eof", code: 0, signal: null },
  };
  return {
    ...payload,
    transcriptSha256: transcriptDigestTampered
      ? "9".repeat(64)
      : canonicalDigest({
          domain: "enduragent.windows-host-native-command-transcript.v1",
          transcript: payload,
        }),
  };
}

async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), "enduragent-native-client-"));
  roots.push(root);
  return root;
}

function runtimeWindowsSystemLibraries() {
  const { sharedObjects } = process.report.getReport() as { readonly sharedObjects?: unknown };
  if (!Array.isArray(sharedObjects) || sharedObjects.some((entry) => typeof entry !== "string")) {
    throw new Error("Node diagnostic report did not expose loaded system libraries");
  }
  return sharedObjects;
}

function runRawProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  input: Uint8Array,
) {
  return new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...environment },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error("raw process test timed out"));
      }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.end(input);
    },
  );
}

function runRawNative(
  executable: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  input: Uint8Array,
) {
  return runRawProcess(executable, [], cwd, environment, input);
}

async function observeNativeRunRootIdentity(
  executable: string,
  cwd: string,
  build: {
    readonly candidateDigest: string;
    readonly assemblySha256: string;
    readonly manifestSha256: string;
  },
) {
  const binding = preflightBinding(
    build.assemblySha256,
    "0".repeat(64),
    "bin/windows-host-falsifier-native.exe",
    build.candidateDigest,
    build.manifestSha256,
  );
  const environment = {
    ENDURAGENT_NATIVE_RUN_ROOT: cwd,
    ENDURAGENT_CAMPAIGN_RUN_ID: binding.campaignRunId,
    ENDURAGENT_CAMPAIGN_CANDIDATE_SHA256: binding.candidateSha256,
    ENDURAGENT_PREFLIGHT_SHA256: binding.preflightSha256,
    ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256: binding.executionBundleManifestSha256,
    ENDURAGENT_NATIVE_CANDIDATE_DIGEST: build.candidateDigest,
    ENDURAGENT_NATIVE_MANIFEST_SHA256: build.manifestSha256,
    ENDURAGENT_PREFLIGHT_NATIVE_HELPER_SHA256: build.assemblySha256,
    ENDURAGENT_EVIDENCE_ROOT_OBJECT_IDENTITY_SHA256: binding.evidenceRootObjectIdentitySha256,
    ENDURAGENT_NATIVE_SESSION_ID: "native-root-observer",
  };
  const frame = {
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId: "request-root-observer",
    command: "native-binding-check",
    context: {
      campaignRunId: binding.campaignRunId,
      candidateSha256: binding.candidateSha256,
      preflightSha256: binding.preflightSha256,
      executionBundleManifestSha256: binding.executionBundleManifestSha256,
      nativeCandidateDigest: build.candidateDigest,
      nativeManifestSha256: build.manifestSha256,
      nativeHelperSha256: build.assemblySha256,
      evidenceRootObjectIdentitySha256: binding.evidenceRootObjectIdentitySha256,
      nativeSessionId: environment.ENDURAGENT_NATIVE_SESSION_ID,
      operationId: "operation-root-observer",
    },
    request: {},
  };
  const observed = await runRawNative(
    executable,
    cwd,
    environment,
    Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"),
  );
  expect(observed.code).toBe(0);
  expect(observed.stderr).toHaveLength(0);
  const response = JSON.parse(observed.stdout.toString("utf8")) as {
    readonly ok: boolean;
    readonly context: { readonly runRootIdentity: string };
    readonly error?: { readonly code: string };
  };
  expect(response).toMatchObject({
    ok: false,
    error: { code: "RUN_ROOT_IDENTITY_MISMATCH" },
  });
  return response.context.runRootIdentity;
}

describe("Windows host native falsifier client", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("exposes a unique bounded command allowlist and refuses execution off Windows", async () => {
    expect(new Set(NATIVE_COMMANDS).size).toBe(NATIVE_COMMANDS.length);
    expect(NATIVE_COMMANDS).toContain("evidence-tree-seal");
    expect(NATIVE_COMMANDS).toContain("pipe-name-derive");
    if (process.platform !== "win32") {
      const root = await testRoot();
      await expect(
        invokeNative({
          runRoot: root,
          preflightBinding: preflightBinding(candidateSha256),
          command: "pipe-name-derive",
          request: { appId: "icu.enduragent.desktop", canonicalHomeId: "home-A" },
        } as Parameters<typeof invokeNative>[0]),
      ).rejects.toMatchObject({ code: "NATIVE_PLATFORM" });
    }
  });

  it("declares private-directory requests relative to the preflight-bound root", () => {
    const ensureRequest = {
      relativePath: "private-directory",
      action: "create",
    } satisfies NativeRequestMap["private-directory-ensure"];
    const inspectRequest = {
      relativePath: "private-directory",
    } satisfies NativeRequestMap["private-directory-inspect"];

    expect(ensureRequest).toEqual({ relativePath: "private-directory", action: "create" });
    expect(inspectRequest).toEqual({ relativePath: "private-directory" });
    expect(ensureRequest).not.toHaveProperty("root");
    expect(inspectRequest).not.toHaveProperty("root");
    expect(ensureRequest).not.toHaveProperty("path");
    expect(inspectRequest).not.toHaveProperty("path");
  });

  it("prepares and verifies prerequisites without sending or creating the target", async () => {
    const root = await testRoot();
    const prerequisite = Buffer.from("prepared prerequisite", "utf8");
    await writeFile(join(root, "staged.bin"), prerequisite);
    const sendPrepared = vi.fn(async (_prepared: NativePreparedFrameTransmission) => ({
      ok: true as const,
      result: {},
    }));
    const channel = preparedChannel(root, sendPrepared);

    const prepared = await channel.prepare(
      "private-file-create",
      {
        relativePath: "created.bin",
        contentSource: {
          kind: "staged-file",
          relativePath: "staged.bin",
          bytes: prerequisite.length,
          sha256: createHash("sha256").update(prerequisite).digest("hex"),
        },
      },
      { operationId: "operation-prepare-only", timeoutMs: 1_234 },
    );
    const deterministic = await channel.prepare(
      "private-file-create",
      {
        relativePath: "deterministic.bin",
        contentSource: {
          kind: "deterministic",
          seedHex: "3".repeat(64),
          bytes: 65,
          sha256: "b651079bde89b0226ad3731fc4a47b0b439d5414443a4814febf9b12f82c5444",
        },
      },
      { operationId: "operation-prepare-deterministic" },
    );

    expect(sendPrepared).not.toHaveBeenCalled();
    await expect(readFile(join(root, "created.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(prepared).toMatchObject({
      command: "private-file-create",
      operationId: "operation-prepare-only",
      timeoutMs: 1_234,
      requestFrame: {
        command: "private-file-create",
        request: {
          relativePath: "created.bin",
          contentSource: {
            kind: "staged-file",
            relativePath: "staged.bin",
            bytes: prerequisite.length,
          },
        },
      },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.requestFrame)).toBe(true);
    expect(Object.isFrozen(prepared.requestFrame.request)).toBe(true);
    expect(deterministic.requestFrame.request).toMatchObject({
      contentSource: { kind: "deterministic", bytes: 65 },
    });
  });

  it("rejects normalization and prerequisite mismatches before any send", async () => {
    const root = await testRoot();
    await writeFile(join(root, "staged.bin"), "verified bytes", "utf8");
    const sendPrepared = vi.fn(async (_prepared: NativePreparedFrameTransmission) => ({
      ok: true as const,
      result: {},
    }));
    const channel = preparedChannel(root, sendPrepared);

    await expect(
      channel.prepare("private-directory-inspect", { relativePath: "../escape" }),
    ).rejects.toMatchObject({ code: "NATIVE_TARGET_PATH" });
    await expect(
      channel.prepare("private-file-create", {
        relativePath: "created.bin",
        contentSource: {
          kind: "staged-file",
          relativePath: "staged.bin",
          bytes: 14,
          sha256: "9".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "NATIVE_CONTENT_MISMATCH" });
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("sends the exact immutable prepared frame once", async () => {
    const root = await testRoot();
    const sent: NativePreparedFrameTransmission[] = [];
    const suffix = "a".repeat(64);
    const sendPrepared = vi.fn(async (prepared: NativePreparedFrameTransmission) => {
      sent.push(prepared);
      return {
        ok: true as const,
        result: {
          pipeName: `\\\\.\\pipe\\Enduragent-upgrade-v1-${suffix}`,
          suffix,
        },
      };
    });
    const channel = preparedChannel(root, sendPrepared);
    const request = { appId: "icu.enduragent.desktop", canonicalHomeId: "home-A" };
    const prepared = await channel.prepare("pipe-name-derive", request, {
      operationId: "operation-exact-frame",
    });
    request.canonicalHomeId = "changed-after-prepare";
    expect(() =>
      Object.assign(prepared.requestFrame.request, { canonicalHomeId: "mutation-attempt" }),
    ).toThrow();

    await expect(channel.executePrepared(prepared)).resolves.toMatchObject({
      command: "pipe-name-derive",
      operationId: "operation-exact-frame",
      ok: true,
      result: { suffix },
    });
    expect(sendPrepared).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].requestFrame).toBe(prepared.requestFrame);
    expect(Buffer.from(sent[0].frameBytes).toString("utf8")).toBe(
      `${JSON.stringify(prepared.requestFrame)}\n`,
    );
    expect(prepared.requestFrame.request).toMatchObject({ canonicalHomeId: "home-A" });
    expect(prepared.requestFrameSha256).toBe(
      createHash("sha256").update(JSON.stringify(prepared.requestFrame), "utf8").digest("hex"),
    );
    await expect(channel.executePrepared(prepared)).rejects.toMatchObject({
      code: "NATIVE_PREPARED_REUSE",
    });
    expect(sendPrepared).toHaveBeenCalledTimes(1);
  });

  it("resolves validated command failures but rejects a dead transport", async () => {
    const root = await testRoot();
    const commandFailure = vi.fn(async (_prepared: NativePreparedFrameTransmission) => ({
      ok: false as const,
      error: { code: "TARGET_EXISTS", message: "target exists", win32Code: 183 },
    }));
    const failureChannel = preparedChannel(root, commandFailure);
    const failed = await failureChannel.prepare("private-directory-inspect", {
      relativePath: "private-directory",
    });
    await expect(failureChannel.executePrepared(failed)).resolves.toEqual({
      command: "private-directory-inspect",
      operationId: failed.operationId,
      ok: false,
      error: { code: "TARGET_EXISTS", message: "target exists", win32Code: 183 },
    });

    const deadTransport = vi.fn(async (_prepared: NativePreparedFrameTransmission) => {
      throw new NativeClientError("NATIVE_CLOSED", "native helper is closed");
    });
    const deadChannel = preparedChannel(root, deadTransport);
    const prepared = await deadChannel.prepare("private-directory-inspect", {
      relativePath: "private-directory",
    });
    await expect(deadChannel.executePrepared(prepared)).rejects.toMatchObject({
      code: "NATIVE_CLOSED",
    });
    expect(deadTransport).toHaveBeenCalledTimes(1);

    const malformedFailure = vi.fn(async (_prepared: NativePreparedFrameTransmission) => ({
      ok: false as const,
      error: { code: "TARGET_EXISTS", message: "target exists" },
    }));
    const malformedChannel = preparedChannel(
      root,
      malformedFailure as unknown as Parameters<typeof preparedChannel>[1],
    );
    const malformed = await malformedChannel.prepare("private-directory-inspect", {
      relativePath: "private-directory",
    });
    await expect(malformedChannel.executePrepared(malformed)).rejects.toMatchObject({
      code: "NATIVE_SCHEMA_MISSING_KEY",
    });

    const compatibleChannel = preparedChannel(root, commandFailure);
    await expect(
      compatibleChannel.execute("private-directory-inspect", {
        relativePath: "private-directory",
      }),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS", win32Code: 183 });
  });

  it("derives the exact portable helper path from a disjoint candidate root", () => {
    expect(
      resolveNativeCandidateArtifactPath({
        candidateRoot: "C:\\Probe Bootstrap\\binaries",
        candidateDirectory: "C:\\Probe Bootstrap\\binaries\\native",
        assemblyPath: "C:\\Probe Bootstrap\\binaries\\native\\windows-host-falsifier-native.exe",
      }),
    ).toBe("native/windows-host-falsifier-native.exe");
    expect(() =>
      resolveNativeCandidateArtifactPath({
        candidateRoot: "C:\\Probe Bootstrap\\binaries",
        candidateDirectory: "C:\\Probe Bootstrap\\escape",
        assemblyPath: "C:\\Probe Bootstrap\\escape\\windows-host-falsifier-native.exe",
      }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_CANDIDATE_ROOT_ESCAPE" }));
    expect(() =>
      resolveNativeCandidateArtifactPath({
        candidateRoot: "C:\\Probe Bootstrap\\binaries",
        candidateDirectory: "c:\\probe bootstrap\\binaries\\native",
        assemblyPath: "c:\\probe bootstrap\\binaries\\native\\windows-host-falsifier-native.exe",
      }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_PATH_CASE_COLLISION" }));
    expect(() =>
      resolveNativeCandidateArtifactPath({
        candidateRoot: "C:\\Probe Bootstrap\\binaries",
        candidateDirectory: "C:\\Probe Bootstrap\\binaries\\native",
        assemblyPath: "C:\\Probe Bootstrap\\binaries\\other\\windows-host-falsifier-native.exe",
      }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_CANDIDATE_DIRECTORY" }));
  });

  it("builds a case-stable child environment without inheriting credentials", () => {
    const environment = buildNativeChildEnvironment(
      {
        Path: "C:\\Windows\\System32",
        systemroot: "C:\\Windows",
        TEMP: "C:\\Temp",
        OPENAI_API_KEY: "must-not-cross",
        ANTHROPIC_AUTH_TOKEN: "must-not-cross",
        HTTPS_PROXY: "http://must-not-cross.invalid",
        NODE_OPTIONS: "--require must-not-cross",
      },
      {
        ENDURAGENT_NATIVE_RUN_ROOT: "C:\\Probe",
        ENDURAGENT_CAMPAIGN_RUN_ID: "campaign-one",
      },
    );

    expect(NATIVE_CHILD_ENV_ALLOWLIST).toEqual([
      "SystemRoot",
      "WINDIR",
      "SystemDrive",
      "ComSpec",
      "PATH",
      "PATHEXT",
      "TEMP",
      "TMP",
    ]);
    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      ENDURAGENT_NATIVE_RUN_ROOT: "C:\\Probe",
      ENDURAGENT_CAMPAIGN_RUN_ID: "campaign-one",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("derives Windows PowerShell from strict SystemRoot and synthesizes its environment", () => {
    const inherited = {
      systemroot: "C:\\Windows",
      WINDIR: "c:\\windows",
      PATH: "Z:\\attacker",
      ComSpec: "Z:\\attacker\\cmd.exe",
      TEMP: "Z:\\attacker-temp",
      HTTPS_PROXY: "http://must-not-cross.invalid",
      OPENAI_API_KEY: "must-not-cross",
      NODE_OPTIONS: "--require must-not-cross",
    };
    const paths = resolveNativeWindowsToolPaths(inherited, syntheticWindowsSystemLibraries);
    expect(paths).toEqual({
      systemRoot: "C:\\Windows",
      system32: "C:\\Windows\\System32",
      powerShellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const environment = buildNativeToolEnvironment(
      inherited,
      "C:\\Probe\\native-build-owned\\temp-owned",
      syntheticWindowsSystemLibraries,
    );
    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Probe\\native-build-owned\\temp-owned",
      TMP: "C:\\Probe\\native-build-owned\\temp-owned",
    });
    expect(Object.isFrozen(environment)).toBe(true);
    expect(environment).not.toHaveProperty("ComSpec");
    expect(environment).not.toHaveProperty("PATHEXT");
  });

  it("classifies private-directory creation failures without disclosing child output", () => {
    expect(
      describePrivateDirectoryCreationFailure({
        code: 43,
        signal: null,
        stderrBytes: 0,
        stdoutMatchesNonce: false,
      }),
    ).toBe("PowerShell observed a mismatched owner, DACL protection flag, or explicit ACE count");
    expect(
      describePrivateDirectoryCreationFailure({
        code: 44,
        signal: null,
        stderrBytes: 0,
        stdoutMatchesNonce: false,
      }),
    ).toBe("PowerShell observed an inexact owner-only Full Control ACE");
    expect(
      describePrivateDirectoryCreationFailure({
        code: 1,
        signal: null,
        stderrBytes: 371,
        stdoutMatchesNonce: true,
      }),
    ).toBe("PowerShell emitted 371 stderr bytes (exit 1, nonce matched)");
    expect(
      describePrivateDirectoryCreationFailure({
        code: 0,
        signal: null,
        stderrBytes: 392,
        stdoutMatchesNonce: true,
      }),
    ).toBeNull();
    expect(
      describePrivateDirectoryCreationFailure({
        code: 0,
        signal: null,
        stderrBytes: 0,
        stdoutMatchesNonce: true,
      }),
    ).toBeNull();
  });

  it("pins native compiler stdout to one explicit console JSON record", async () => {
    const source = await readFile(
      new URL("../scripts/windows-host-falsifier/native/compile.ps1", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "$null = Add-Type -Path $sourcePaths -CompilerParameters $compilerParameters -ErrorAction Stop",
    );
    expect(source).toContain("$metadata = [ordered]@{");
    expect(source).toContain(
      "$metadataJson = ConvertTo-Json -InputObject $metadata -Compress -Depth 5",
    );
    expect(source.trimEnd()).toMatch(/\[Console\]::Out\.WriteLine\(\[string\]\$metadataJson\)$/u);
    expect(source).not.toContain("} | ConvertTo-Json -Compress -Depth 5");
  });

  it("rejects ambiguous or noncanonical Windows system roots", () => {
    for (const environment of [
      { WINDIR: "C:\\Windows" },
      { SystemRoot: "C:\\Windows", systemroot: "C:\\Windows" },
      { SystemRoot: "C:\\Windows", WINDIR: "D:\\Windows" },
      { SystemRoot: "Windows" },
      { SystemRoot: "\\\\server\\share\\Windows" },
      { SystemRoot: "\\\\?\\C:\\Windows" },
      { SystemRoot: "C:/Windows" },
      { SystemRoot: "C:\\Windows\\..\\Windows" },
      { SystemRoot: "C:\\Windows. " },
      { SystemRoot: "C:\\Windows:alternate" },
    ]) {
      expect(() =>
        resolveNativeWindowsToolPaths(environment, syntheticWindowsSystemLibraries),
      ).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^NATIVE_SYSTEM_ROOT/u) }),
      );
    }
    expect(() =>
      resolveNativeWindowsToolPaths({ SystemRoot: "D:\\Windows" }, syntheticWindowsSystemLibraries),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SYSTEM_ROOT_MISMATCH" }));
    expect(() =>
      resolveNativeWindowsToolPaths({ SystemRoot: "C:\\Windows" }, [
        "C:\\Windows\\System32\\kernel32.dll",
      ]),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SYSTEM_ROOT_ANCHOR" }));
  });

  it("rejects case-colliding base keys and unallowlisted protocol bindings", () => {
    expect(() => buildNativeChildEnvironment({ PATH: "one", Path: "two" })).toThrowError(
      expect.objectContaining({ code: "NATIVE_ENV_COLLISION" }),
    );
    expect(() =>
      buildNativeChildEnvironment({}, { ENDURAGENT_CONTROLLER_PRIVATE_KEY: "must-not-cross" }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_ENV_BINDING" }));
  });

  it("recomputes exact artifact-set seals and rejects digest tampering", () => {
    const entry = {
      path: "facts/raw.json",
      type: "file" as const,
      bytes: 7,
      sha256: "d".repeat(64),
      objectIdentity: "volume-v1:file-v1",
    };
    const rootObjectIdentity = "volume-v1:root-v1";
    const setSha256 = framedDigest(
      "enduragent.windows-evidence-artifact-set-seal.v1",
      rootObjectIdentity,
      entry.path,
      entry.type,
      String(entry.bytes),
      entry.sha256,
      entry.objectIdentity,
    );
    const seal = {
      mode: "exact-paths" as const,
      rootObjectIdentity,
      entryCount: 1,
      entries: [entry],
      totalBytes: 7,
      setSha256,
    };
    expect(validateNativeEvidenceSeal(seal)).toEqual(seal);
    expect(() => validateNativeEvidenceSeal({ ...seal, setSha256: "e".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "NATIVE_RESULT_DIGEST" }),
    );
    const caseAlias = {
      ...seal,
      entryCount: 2,
      entries: [
        { ...entry, path: "facts/A.json" },
        { ...entry, path: "facts/a.json" },
      ],
      totalBytes: 14,
    };
    expect(() => validateNativeEvidenceSeal(caseAlias)).toThrowError(
      expect.objectContaining({ code: "NATIVE_PATH_CASE_COLLISION" }),
    );
  });

  it("rejects extra or malformed fields in command results", () => {
    const result = {
      pipeName:
        "\\\\.\\pipe\\Enduragent-upgrade-v1-ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
      suffix: "ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
    };
    expect(validateNativeCommandResult("pipe-name-derive", result)).toEqual(result);
    expect(() =>
      validateNativeCommandResult("pipe-name-derive", { ...result, untrusted: true }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SCHEMA_UNKNOWN_KEY" }));
    expect(() =>
      validateNativeCommandResult("pipe-name-derive", { ...result, suffix: "A".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SCHEMA_DIGEST" }));
  });

  it("revalidates native transcripts while retaining only pipe-secret projections", () => {
    const transcript: NativeCommandTranscript =
      validateNativeCommandTranscript(nativeTranscriptFixture());
    expect(transcript).toEqual(nativeTranscriptFixture());
    expect(Object.isFrozen(transcript)).toBe(true);
    expect(Object.isFrozen(transcript.records)).toBe(true);
    const firstRecord = transcript.records[0];
    if (firstRecord?.kind !== "command") throw new Error("expected retained command record");
    const retainedRequest = firstRecord.request;
    expect(retainedRequest).toMatchObject({
      capabilitySha256: hexProjection("2".repeat(64)),
      bindingSha256: hexProjection("3".repeat(64)),
    });
    expect(retainedRequest).not.toHaveProperty("capabilityHex");
    expect(retainedRequest).not.toHaveProperty("bindingHex");
    expect(JSON.stringify(transcript)).not.toContain("2".repeat(64));
    expect(JSON.stringify(transcript)).not.toContain("3".repeat(64));
    expect(firstRecord.requestFrameSha256).toBe(
      canonicalDigest({
        protocolVersion: 1,
        requestId: "req-owner",
        command: "pipe-owner",
        context: {
          campaignRunId: transcript.binding.campaignRunId,
          candidateSha256: transcript.binding.candidateSha256,
          preflightSha256: transcript.binding.preflightSha256,
          executionBundleManifestSha256: transcript.binding.executionBundleManifestSha256,
          nativeCandidateDigest: transcript.binding.nativeCandidateDigest,
          nativeManifestSha256: transcript.binding.nativeManifestSha256,
          nativeHelperSha256: transcript.binding.nativeHelperSha256,
          evidenceRootObjectIdentitySha256: transcript.binding.evidenceRootObjectIdentitySha256,
          nativeSessionId: transcript.binding.nativeSessionId,
          operationId: "op-owner",
        },
        request: {
          pipeName:
            "\\\\.\\pipe\\Enduragent-upgrade-v1-ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
          capabilityHex: "2".repeat(64),
          bindingHex: "3".repeat(64),
          maxFrameBytes: 4096,
          connectDeadlineMs: 5000,
          readDeadlineMs: 5000,
        },
      }),
    );

    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ requestDigestTampered: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_REQUEST_RECEIPT" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ responseDigestTampered: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_RESPONSE_DIGEST" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ eventDigestTampered: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_EVENT_DIGEST" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ transcriptDigestTampered: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_DIGEST" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ rawPipeSecretsRetained: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SCHEMA_UNKNOWN_KEY" }));
    expect(() =>
      validateNativeCommandTranscript(
        nativeTranscriptFixture({ rootIdentityDigestTampered: true }),
      ),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_BINDING" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ startupHandshakeTampered: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_HANDSHAKE" }));
    for (const [key, value] of [
      ["nativeCandidateDigest", "7".repeat(64)],
      ["nativeManifestSha256", "8".repeat(64)],
    ] as const) {
      const substituted = validateNativeCommandTranscript(
        nativeTranscriptFixture({ [key]: value }),
      );
      expect(substituted.binding[key]).toBe(value);
    }
  });

  it("rejects transcript schema, ordering, payload, and session-ownership tampering", () => {
    expect(() =>
      validateNativeCommandTranscript({ ...nativeTranscriptFixture(), unexpected: true }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SCHEMA_UNKNOWN_KEY" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ eventRecordSequence: 3 })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_SCHEMA" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ resultExtraField: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_SCHEMA_UNKNOWN_KEY" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ eventSessionId: "ns-other" })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_SESSION" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ controlSessionId: "ns-other" })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_SESSION" }));
    expect(() =>
      validateNativeCommandTranscript(nativeTranscriptFixture({ ownerCommandFailed: true })),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_TRANSCRIPT_SESSION" }));
  });

  it.runIf(process.platform === "win32")(
    "holds a preflight-bound image across a multi-command channel and seals exact artifacts",
    async () => {
      const labRoot = await testRoot();
      const canonicalLabRoot = await realpath(labRoot);
      const buildRoot = join(labRoot, "build-root");
      const runRoot = join(labRoot, "run-root");
      const candidateRootPath = join(labRoot, "candidate-root");
      const candidateDirectoryPath = join(candidateRootPath, "native");
      await Promise.all([mkdir(buildRoot), mkdir(runRoot), mkdir(candidateRootPath)]);
      await expect(
        buildNativeHelper({ runRoot: `\\\\?\\${buildRoot}`, timeoutMs: 90_000 }),
      ).rejects.toMatchObject({ code: "NATIVE_RUN_ROOT" });
      const built = await buildNativeHelper({ runRoot: buildRoot, timeoutMs: 90_000 });
      await cp(built.buildDirectory, candidateDirectoryPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      const [candidateRoot, candidateDirectory] = await Promise.all([
        realpath(candidateRootPath),
        realpath(candidateDirectoryPath),
      ]);
      const loaded = await loadNativeHelper({ candidateRoot, candidateDirectory });
      expect(loaded).toMatchObject({
        candidateRoot,
        candidateDirectory,
        nativeHelperArtifactPath: "native/windows-host-falsifier-native.exe",
        assemblySha256: built.assemblySha256,
        sourceBundleSha256: built.sourceBundleSha256,
        toolchainDigest: built.toolchainDigest,
        candidateDigest: built.candidateDigest,
        manifestSha256: built.manifestSha256,
      });
      const windowsTools = resolveNativeWindowsToolPaths(
        process.env,
        runtimeWindowsSystemLibraries(),
      );
      const powerShellSha256 = createHash("sha256")
        .update(await readFile(windowsTools.powerShellExecutable))
        .digest("hex");
      expect(loaded.toolchain).toMatchObject({
        powerShellExecutableSha256Before: powerShellSha256,
        powerShellExecutableSha256After: powerShellSha256,
      });
      const runRootIdentity = await observeNativeRunRootIdentity(
        loaded.assemblyPath,
        runRoot,
        loaded,
      );
      const artifactPath = "native/windows-host-falsifier-native.exe";
      const binding = preflightBinding(
        loaded.assemblySha256,
        createHash("sha256").update(runRootIdentity, "utf8").digest("hex"),
        artifactPath,
        loaded.candidateDigest,
        loaded.manifestSha256,
      );
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: binding,
          candidateDirectory,
        } as Parameters<typeof openNativeChannel>[0]),
      ).rejects.toMatchObject({ code: "NATIVE_CANDIDATE_BINDING" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: preflightBinding(
            loaded.assemblySha256,
            binding.evidenceRootObjectIdentitySha256,
            "candidate-root/native/windows-host-falsifier-native.exe",
            loaded.candidateDigest,
            loaded.manifestSha256,
          ),
          candidateRoot: canonicalLabRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_CANDIDATE_RUN_ROOT_OVERLAP" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: preflightBinding(
            loaded.assemblySha256,
            "0".repeat(64),
            artifactPath,
            loaded.candidateDigest,
            loaded.manifestSha256,
          ),
          candidateRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_ROOT_IDENTITY_MISMATCH" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: preflightBinding(
            loaded.assemblySha256,
            binding.evidenceRootObjectIdentitySha256,
            "other/windows-host-falsifier-native.exe",
            loaded.candidateDigest,
            loaded.manifestSha256,
          ),
          candidateRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_PREFLIGHT_HELPER_PATH_MISMATCH" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: preflightBinding(
            loaded.assemblySha256,
            binding.evidenceRootObjectIdentitySha256,
            `prefix/${artifactPath}`,
            loaded.candidateDigest,
            loaded.manifestSha256,
          ),
          candidateRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_PREFLIGHT_HELPER_PATH_MISMATCH" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: { ...binding, nativeCandidateDigest: "7".repeat(64) },
          candidateRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_PREFLIGHT_CANDIDATE_MISMATCH" });
      await expect(
        openNativeChannel({
          runRoot,
          preflightBinding: { ...binding, nativeManifestSha256: "8".repeat(64) },
          candidateRoot,
          candidateDirectory,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_PREFLIGHT_MANIFEST_MISMATCH" });

      await mkdir(join(runRoot, "evidence"));
      await writeFile(
        join(runRoot, "evidence", "fact.txt"),
        "synthetic-native-regression\n",
        "utf8",
      );
      const channel = await openNativeChannel({
        runRoot,
        preflightBinding: binding,
        candidateRoot,
        candidateDirectory,
      });
      const ensuredPrivateDirectory = await channel.execute("private-directory-ensure", {
        relativePath: "private-directory",
        action: "create",
      });
      expect(ensuredPrivateDirectory.result).toMatchObject({
        protectedAcl: true,
        unexpectedAceCount: 0,
      });
      await expect(
        channel.execute("private-directory-inspect", {
          relativePath: "private-directory",
        }),
      ).resolves.toMatchObject({
        result: { objectIdentity: ensuredPrivateDirectory.result.objectIdentity },
      });
      const duplicateAclMutation = await runRawProcess(
        windowsTools.powerShellExecutable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(duplicatePrivateDirectoryAclPowerShell, "utf16le").toString("base64"),
        ],
        runRoot,
        { ENDURAGENT_NATIVE_ACL_TEST_PATH: join(runRoot, "private-directory") },
        Buffer.alloc(0),
      );
      expect(duplicateAclMutation).toMatchObject({ code: 0, stderr: Buffer.alloc(0) });
      const duplicateInspection = await channel.execute("private-directory-inspect", {
        relativePath: "private-directory",
      });
      expect(duplicateInspection.result).toMatchObject({
        protectedAcl: true,
        principals: expect.arrayContaining(["current-user", "System", "Administrators"]),
        unexpectedAceCount: 1,
      });
      expect(duplicateInspection.result.principals).toHaveLength(3);
      await expect(
        channel.execute("private-directory-ensure", {
          relativePath: "private-directory",
          action: "repair",
        }),
      ).resolves.toMatchObject({
        result: {
          objectIdentity: ensuredPrivateDirectory.result.objectIdentity,
          protectedAcl: true,
          principals: ["current-user", "System", "Administrators"],
          unexpectedAceCount: 0,
        },
      });
      const callbackAclMutation = await runRawProcess(
        windowsTools.powerShellExecutable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(callbackPrivateDirectoryAclPowerShell, "utf16le").toString("base64"),
        ],
        runRoot,
        { ENDURAGENT_NATIVE_ACL_TEST_PATH: join(runRoot, "private-directory") },
        Buffer.alloc(0),
      );
      expect(callbackAclMutation).toMatchObject({ code: 0, stderr: Buffer.alloc(0) });
      const callbackInspection = await channel.execute("private-directory-inspect", {
        relativePath: "private-directory",
      });
      expect(callbackInspection.result).toMatchObject({
        protectedAcl: true,
        principals: expect.arrayContaining(["current-user", "System", "Administrators"]),
        unexpectedAceCount: 1,
      });
      expect(callbackInspection.result.principals).toHaveLength(3);
      await expect(
        channel.execute("private-directory-ensure", {
          relativePath: "private-directory",
          action: "repair",
        }),
      ).resolves.toMatchObject({
        result: {
          objectIdentity: ensuredPrivateDirectory.result.objectIdentity,
          protectedAcl: true,
          principals: ["current-user", "System", "Administrators"],
          unexpectedAceCount: 0,
        },
      });
      await expect(
        channel.execute("private-directory-ensure", {
          relativePath: "PRIVATE-DIRECTORY",
          action: "create",
        }),
      ).rejects.toMatchObject({ code: "TARGET_EXISTS" });

      for (const request of [
        { root: runRoot, relativePath: "private-directory" },
        { path: join(runRoot, "private-directory") },
        { relativePath: "private-directory", RelativePath: "private-directory" },
      ]) {
        await expect(
          channel.execute(
            "private-directory-inspect",
            request as unknown as NativeRequestMap["private-directory-inspect"],
          ),
        ).rejects.toMatchObject({ code: "NATIVE_SCHEMA_UNKNOWN_KEY" });
      }
      for (const relativePath of [join(runRoot, "absolute-directory"), "..\\outside-directory"]) {
        await expect(
          channel.execute("private-directory-inspect", { relativePath }),
        ).rejects.toMatchObject({ code: "NATIVE_TARGET_PATH" });
      }

      const outsideDirectory = join(labRoot, "outside-directory");
      await mkdir(outsideDirectory);
      await symlink(outsideDirectory, join(runRoot, "escape-link"), "junction");
      await expect(
        channel.execute("private-directory-inspect", {
          relativePath: "escape-link\\outside-child",
        }),
      ).rejects.toMatchObject({ code: "REPARSE_POINT" });
      await expect(
        channel.execute("private-directory-ensure", {
          relativePath: "escape-link\\outside-child",
          action: "create",
        }),
      ).rejects.toMatchObject({ code: "REPARSE_POINT" });

      const derivedPipe = await channel.execute(
        "pipe-name-derive",
        {
          appId: "icu.enduragent.desktop",
          canonicalHomeId: "home-A",
        },
        { operationId: "native-step-signed-plan-01" },
      );
      expect(derivedPipe).toMatchObject({
        operationId: "native-step-signed-plan-01",
        result: {
          pipeName:
            "\\\\.\\pipe\\Enduragent-upgrade-v1-ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
        },
      });
      await expect(
        channel.execute(
          "pipe-name-derive",
          {
            appId: "icu.enduragent.desktop",
            canonicalHomeId: "home-A",
          },
          { operationId: "native-step-signed-plan-01" },
        ),
      ).rejects.toMatchObject({ code: "NATIVE_OPERATION_ID_REUSE" });
      await expect(
        channel.execute("pipe-name-derive", {
          appId: "icu.enduragent.desktop",
          canonicalHomeId: "home-B",
        }),
      ).resolves.toMatchObject({
        result: {
          pipeName:
            "\\\\.\\pipe\\Enduragent-upgrade-v1-e5bd25ef024958a42053b684b05b3bd185e0642985aebcb863af6ea312678112",
        },
      });
      const capabilityHex = "ab".repeat(32);
      const pipeBindingHex = "cd".repeat(32);
      const pipeRequest = {
        pipeName: derivedPipe.result.pipeName,
        capabilityHex,
        bindingHex: pipeBindingHex,
        maxFrameBytes: 4096,
        connectDeadlineMs: 5000,
        readDeadlineMs: 5000,
      };
      const pipeOwner = await channel.execute("pipe-owner", pipeRequest);
      await expect(channel.nextEvent()).resolves.toMatchObject({
        event: "ready",
        sessionId: pipeOwner.result.sessionId,
      });
      await expect(
        channel.execute("pipe-client", { ...pipeRequest, role: "successor" }),
      ).resolves.toMatchObject({ result: { decision: "designated" } });
      await expect(channel.nextEvent()).resolves.toMatchObject({
        event: "client-decision",
        sessionId: pipeOwner.result.sessionId,
        data: { decision: "designated" },
      });
      await expect(channel.control(pipeOwner.result.sessionId, "close")).resolves.toMatchObject({
        result: { state: "closed" },
      });

      let writableImageHandle;
      let writeOpenError;
      try {
        writableImageHandle = await open(loaded.assemblyPath, "r+");
      } catch (error) {
        writeOpenError = error;
      } finally {
        await writableImageHandle?.close();
      }
      expect(writeOpenError).toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
      });

      const seal = await channel.execute("evidence-tree-seal", {
        relativePath: "evidence",
        mode: "exact-paths",
        exactPaths: ["fact.txt"],
        maxDepth: 4,
        maxEntries: 16,
        maxFileBytes: 4096,
        maxTotalBytes: 16_384,
      });
      expect(seal.result).toMatchObject({
        mode: "exact-paths",
        totalBytes: 28,
        entries: [
          {
            path: "fact.txt",
            type: "file",
            bytes: 28,
          },
        ],
      });
      if (seal.result.mode !== "exact-paths") throw new Error("expected exact-paths seal");
      expect(seal.result.setSha256).toMatch(/^[a-f0-9]{64}$/u);

      const aliasPath = join(runRoot, "evidence", "fact-alias.txt");
      await link(join(runRoot, "evidence", "fact.txt"), aliasPath);
      await expect(
        channel.execute("evidence-tree-seal", {
          relativePath: "evidence",
          mode: "exact-paths",
          exactPaths: ["fact.txt"],
          maxDepth: 4,
          maxEntries: 16,
          maxFileBytes: 4096,
          maxTotalBytes: 16_384,
        }),
      ).rejects.toMatchObject({ code: "EVIDENCE_HARD_LINK" });
      await rm(aliasPath);

      await writeFile(join(runRoot, "evidence", "fäct.txt"), "unsafe alias surface\n", "utf8");
      await expect(
        channel.execute("evidence-tree-seal", {
          relativePath: "evidence",
          mode: "exact-paths",
          exactPaths: ["fäct.txt"],
          maxDepth: 4,
          maxEntries: 16,
          maxFileBytes: 4096,
          maxTotalBytes: 16_384,
        }),
      ).rejects.toMatchObject({ code: "EVIDENCE_PATH_COMPONENT" });

      await mkdir(join(runRoot, "évidence-root"));
      await writeFile(
        join(runRoot, "évidence-root", "fact.txt"),
        "unicode root is allowed\n",
        "utf8",
      );
      await expect(
        channel.execute("evidence-tree-seal", {
          relativePath: "évidence-root",
          mode: "exact-paths",
          exactPaths: ["fact.txt"],
          maxDepth: 4,
          maxEntries: 16,
          maxFileBytes: 4096,
          maxTotalBytes: 16_384,
        }),
      ).resolves.toMatchObject({
        mode: "exact-paths",
        entries: [{ path: "fact.txt", type: "file" }],
      });
      const liveTranscript = channel.transcript();
      expect(liveTranscript).toMatchObject({
        binding: {
          candidateSha256,
          nativeHelperSha256: loaded.assemblySha256,
          nativeCandidateDigest: loaded.candidateDigest,
        },
        termination: null,
      });
      const pipeRecords = liveTranscript.records.filter(
        (record) =>
          record.kind === "command" &&
          (record.command === "pipe-owner" || record.command === "pipe-client"),
      );
      expect(pipeRecords).toHaveLength(2);
      for (const record of pipeRecords) {
        if (record.kind !== "command") throw new Error("expected pipe command record");
        expect(record.requestFrameVerification).toBe("native-receipt");
        expect(record.nativeRequestFrameSha256).toBe(record.requestFrameSha256);
        expect(record.request).not.toHaveProperty("capabilityHex");
        expect(record.request).not.toHaveProperty("bindingHex");
      }
      expect(JSON.stringify(liveTranscript)).not.toContain(capabilityHex);
      expect(JSON.stringify(liveTranscript)).not.toContain(pipeBindingHex);
      const completed = await channel.close();
      expect(completed.transcript.termination).toEqual({
        mode: "clean-eof",
        code: 0,
        signal: null,
      });
      const releasedImage = await open(loaded.assemblyPath, "r+");
      await releasedImage.close();

      const terminating = await openNativeChannel({
        runRoot,
        preflightBinding: binding,
        candidateRoot,
        candidateDirectory,
      });
      await terminating.execute("pipe-name-derive", {
        appId: "icu.enduragent.desktop",
        canonicalHomeId: "home-A",
      });
      const terminated = await terminating.terminateExpected({
        expectedExit: { code: null, signal: "SIGTERM" },
      });
      expect(terminated.transcript.termination).toMatchObject({
        mode: "expected-termination",
        expectedCode: null,
        expectedSignal: "SIGTERM",
      });
    },
    180_000,
  );

  it.runIf(process.platform === "win32")(
    "enforces strict line framing and duplicate request identities in the compiled helper",
    async () => {
      const root = await testRoot();
      const built = await buildNativeHelper({ runRoot: root, timeoutMs: 90_000 });
      const runRootIdentity = await observeNativeRunRootIdentity(built.assemblyPath, root, built);
      const evidenceRootObjectIdentitySha256 = createHash("sha256")
        .update(runRootIdentity, "utf8")
        .digest("hex");
      const environment = {
        ENDURAGENT_NATIVE_RUN_ROOT: root,
        ENDURAGENT_CAMPAIGN_RUN_ID: "campaign-protocol",
        ENDURAGENT_CAMPAIGN_CANDIDATE_SHA256: candidateSha256,
        ENDURAGENT_PREFLIGHT_SHA256: "b".repeat(64),
        ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256: "c".repeat(64),
        ENDURAGENT_NATIVE_CANDIDATE_DIGEST: built.candidateDigest,
        ENDURAGENT_NATIVE_MANIFEST_SHA256: built.manifestSha256,
        ENDURAGENT_PREFLIGHT_NATIVE_HELPER_SHA256: built.assemblySha256,
        ENDURAGENT_EVIDENCE_ROOT_OBJECT_IDENTITY_SHA256: evidenceRootObjectIdentitySha256,
        ENDURAGENT_NATIVE_SESSION_ID: "native-protocol",
      };
      const context = {
        campaignRunId: environment.ENDURAGENT_CAMPAIGN_RUN_ID,
        candidateSha256,
        preflightSha256: environment.ENDURAGENT_PREFLIGHT_SHA256,
        executionBundleManifestSha256: environment.ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256,
        nativeCandidateDigest: built.candidateDigest,
        nativeManifestSha256: built.manifestSha256,
        nativeHelperSha256: built.assemblySha256,
        evidenceRootObjectIdentitySha256,
        nativeSessionId: environment.ENDURAGENT_NATIVE_SESSION_ID,
      };
      const bindingFrame = {
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: "request-binding",
        command: "native-binding-check",
        context: { ...context, operationId: "operation-binding" },
        request: {},
      };
      const frame = {
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        requestId: "request-one",
        command: "pipe-name-derive",
        context: { ...context, operationId: "operation-one" },
        request: { appId: "icu.enduragent.desktop", canonicalHomeId: "home-A" },
      };
      const encoded = Buffer.from(
        `${JSON.stringify(bindingFrame)}\n${JSON.stringify(frame)}\n${JSON.stringify(frame)}\n`,
        "utf8",
      );
      const duplicate = await runRawNative(built.assemblyPath, root, environment, encoded);
      expect(duplicate.code).toBe(0);
      expect(duplicate.stderr).toHaveLength(0);
      const responses = duplicate.stdout
        .toString("utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              ok: boolean;
              context: { requestFrameSha256: string };
              error?: { code: string };
            },
        );
      expect(responses).toHaveLength(3);
      expect(responses[0].ok).toBe(true);
      expect(responses[0].context.requestFrameSha256).toBe(
        createHash("sha256").update(JSON.stringify(bindingFrame), "utf8").digest("hex"),
      );
      expect(responses[1].ok).toBe(true);
      expect(responses[1].context.requestFrameSha256).toBe(
        createHash("sha256").update(JSON.stringify(frame), "utf8").digest("hex"),
      );
      expect(responses[2]).toMatchObject({
        ok: false,
        error: { code: "DUPLICATE_REQUEST_ID" },
      });
      expect(responses[2].context.requestFrameSha256).toBe(responses[1].context.requestFrameSha256);

      const oversized = await runRawNative(
        built.assemblyPath,
        root,
        { ...environment, ENDURAGENT_NATIVE_SESSION_ID: "native-oversized" },
        Buffer.concat([Buffer.alloc(64 * 1024 + 1, 0x61), Buffer.from("\n")]),
      );
      expect(oversized.code).toBe(2);
      expect(oversized.stdout).toHaveLength(0);
      expect(oversized.stderr).toHaveLength(0);
    },
    180_000,
  );

  it("uses typed client errors", () => {
    expect(new NativeClientError("SYNTHETIC", "synthetic")).toMatchObject({
      name: "NativeClientError",
      code: "SYNTHETIC",
    });
  });
});
