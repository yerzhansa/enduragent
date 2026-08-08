import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumSourceBytes = 16 * 1024 * 1024;
const maximumNativeTranscriptBytes = 64 * 1024 * 1024;
const maximumControllerActionAttestationBytes = 16 * 1024 * 1024;
const maximumInputBytes = 96 * 1024 * 1024;
const maximumOutputBytes = 16 * 1024 * 1024;

const isolateBootstrap = String.raw`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {
const vm = await import("node:vm");
const allowedBuiltins = new Set(["node:buffer", "node:crypto", "node:path", "node:url"]);
const context = vm.createContext(Object.create(null), {
  name: "retained-probe-verifier",
  codeGeneration: { strings: false, wasm: false },
});
const { TextDecoder, TextEncoder } = await import("node:util");
context.TextDecoder = TextDecoder;
context.TextEncoder = TextEncoder;
const { Buffer: ContextBuffer } = await import("node:buffer");
context.Buffer = ContextBuffer;

async function syntheticBuiltin(specifier) {
  const namespace = await import(specifier);
  const names = Object.keys(namespace);
  const module = new vm.SyntheticModule(names, function initialise() {
    for (const name of names) this.setExport(name, namespace[name]);
  }, { context, identifier: specifier });
  await module.link(() => { throw new Error("builtin synthetic modules cannot import"); });
  await module.evaluate();
  return module;
}

const builtins = new Map();
async function builtin(specifier) {
  if (!builtins.has(specifier)) builtins.set(specifier, await syntheticBuiltin(specifier));
  return builtins.get(specifier);
}

const deniedBuiltins = new Map();
async function deniedBuiltin(specifier, names) {
  if (!deniedBuiltins.has(specifier)) {
    const module = new vm.SyntheticModule(names, function initialise() {
      for (const name of names) {
        this.setExport(name, () => { throw new Error(specifier + " is unavailable in retained validation"); });
      }
    }, { context, identifier: specifier });
    await module.link(() => { throw new Error("denied synthetic modules cannot import"); });
    await module.evaluate();
    deniedBuiltins.set(specifier, module);
  }
  return deniedBuiltins.get(specifier);
}

const contract = new vm.SourceTextModule(request.contractSource, {
  context,
  identifier: "memory:///probe-contract.mjs",
});
await contract.link(async (specifier) => {
  if (allowedBuiltins.has(specifier)) return builtin(specifier);
  throw new Error("contract imported an unallowlisted module: " + specifier);
});
await contract.evaluate();

const registry = new vm.SourceTextModule(request.registrySource, {
  context,
  identifier: "memory:///probe-registry.mjs",
});
await registry.link(async (specifier) => {
  if (specifier === "./probe-contract.mjs") return contract;
  if (allowedBuiltins.has(specifier)) return builtin(specifier);
  throw new Error("registry imported an unallowlisted module: " + specifier);
});
await registry.evaluate();

let transcript = null;
if (request.transcriptSource !== null) {
  transcript = new vm.SourceTextModule(request.transcriptSource, {
    context,
    identifier: "memory:///probe-transcript.mjs",
  });
  await transcript.link(async (specifier) => {
    if (specifier === "./probe-contract.mjs") return contract;
    if (allowedBuiltins.has(specifier)) return builtin(specifier);
    throw new Error("transcript reducer imported an unallowlisted module: " + specifier);
  });
  await transcript.evaluate();
}

let nativeManifestDigest = null;
if (request.nativeManifestDigestSource !== null) {
  nativeManifestDigest = new vm.SourceTextModule(request.nativeManifestDigestSource, {
    context,
    identifier: "file:///retained/native-manifest-digest.mjs",
  });
  await nativeManifestDigest.link(async (specifier) => {
    if (specifier === "node:buffer" || specifier === "node:crypto") return builtin(specifier);
    throw new Error("native manifest digest helper imported an unallowlisted module: " + specifier);
  });
  await nativeManifestDigest.evaluate();
}

let nativeClient = null;
if (request.nativeClientSource !== null) {
  nativeClient = new vm.SourceTextModule(request.nativeClientSource, {
    context,
    identifier: "file:///retained/native-client.mjs",
    initializeImportMeta(meta) { meta.url = "file:///retained/native-client.mjs"; },
  });
  await nativeClient.link(async (specifier) => {
    if (specifier === "./native-manifest-digest.mjs" && nativeManifestDigest !== null) {
      return nativeManifestDigest;
    }
    if (specifier === "./broker/mailbox-protocol.mjs") {
      return deniedBuiltin(specifier, [
        "validateProbeBrokerEnrollment",
        "validateProbePreparedBrokerEnrollment",
      ]);
    }
    if (allowedBuiltins.has(specifier)) return builtin(specifier);
    if (specifier === "node:child_process") return deniedBuiltin(specifier, ["spawn"]);
    if (specifier === "node:fs/promises") {
      return deniedBuiltin(specifier, ["lstat", "mkdir", "open", "readdir", "realpath", "rm"]);
    }
    throw new Error("native transcript validator imported an unallowlisted module: " + specifier);
  });
  await nativeClient.evaluate();
}

const byteDecoder = new vm.SourceTextModule(
  'import { Buffer } from "node:buffer"; export const decode = (value) => Uint8Array.from(Buffer.from(value, "base64"));',
  { context, identifier: "memory:///byte-decoder.mjs" },
);
await byteDecoder.link(async (specifier) => {
  if (specifier === "node:buffer") return builtin(specifier);
  throw new Error("byte decoder imported an unallowlisted module: " + specifier);
});
await byteDecoder.evaluate();

let result;
if (request.action === "definition") {
  result = registry.namespace.getProbeVerifierDefinition(request.rowId, request.variantId);
} else if (request.action === "transcript-fact-definition") {
  result = registry.namespace.getProbeTranscriptFactDefinition(request.rowId, request.variantId);
} else if (request.action === "verify") {
  context.__verifierInputJson = JSON.stringify(request.input);
  const verifierInput = vm.runInContext("JSON.parse(__verifierInputJson)", context);
  delete context.__verifierInputJson;
  result = registry.namespace.verifyProbeFacts(verifierInput);
} else if (request.action === "reduce-transcript") {
  if (transcript === null) throw new Error("retained transcript reducer source is unavailable");
  if (nativeClient === null) throw new Error("retained native transcript validator is unavailable");
  context.__transcriptInputJson = JSON.stringify(request.input);
  const transcriptInput = vm.runInContext("JSON.parse(__transcriptInputJson)", context);
  delete context.__transcriptInputJson;
  transcriptInput.sourceTranscriptBytes = byteDecoder.namespace.decode(
    request.sourceTranscriptBytesBase64,
  );
  transcriptInput.controllerPublicKeyBytes = byteDecoder.namespace.decode(
    request.controllerPublicKeyBytesBase64,
  );
  const trustedNativeTranscripts = request.trustedNativeTranscriptBytesBase64.map(
    (encoded) => {
      const bytes = byteDecoder.namespace.decode(encoded);
      const parsed = JSON.parse(ContextBuffer.from(bytes).toString("utf8"));
      const validated = nativeClient.namespace.validateNativeCommandTranscript(parsed);
      return {
        transcriptSha256: validated.transcriptSha256,
        binding: validated.binding,
        commandRecords: validated.records
          .filter((record) => record.kind === "command")
          .map((record) => ({
            command: record.command,
            requestFrameSha256: record.requestFrameSha256,
            responseFrameSha256: record.responseFrameSha256,
            ok: record.ok,
          })),
      };
    },
  );
  context.__nativeTranscriptEvidenceJson = JSON.stringify(trustedNativeTranscripts);
  transcriptInput.trustedNativeTranscripts = vm.runInContext(
    "JSON.parse(__nativeTranscriptEvidenceJson)",
    context,
  );
  delete context.__nativeTranscriptEvidenceJson;
  transcriptInput.trustedControllerActionAttestationBytes =
    request.trustedControllerActionAttestationBytesBase64.map((encoded) =>
      byteDecoder.namespace.decode(encoded),
    );
  result = transcript.namespace.reduceProbeSourceTranscript(transcriptInput);
} else if (request.action === "validate-native-transcript") {
  if (nativeClient === null) throw new Error("retained native transcript validator is unavailable");
  const bytes = byteDecoder.namespace.decode(request.nativeTranscriptBytesBase64);
  result = nativeClient.namespace.validateNativeCommandTranscript(
    JSON.parse(ContextBuffer.from(bytes).toString("utf8")),
  );
} else {
  throw new Error("unallowlisted verifier-isolate action");
}
process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      name: typeof error?.name === "string" ? error.name : "Error",
      code: typeof error?.code === "string" ? error.code : "VERIFIER_ISOLATE_EXECUTION",
      message: typeof error?.message === "string" ? error.message : "retained authority execution failed",
    },
  }));
  process.exitCode = 1;
}
`;

export class ProbeVerifierIsolateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeVerifierIsolateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeVerifierIsolateError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeJson(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  if (exactObject(value)) {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  return value;
}

function requireSourceBytes(value, label) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > maximumSourceBytes
  ) {
    fail("VERIFIER_ISOLATE_SOURCE", `${label} must be bounded non-empty bytes`);
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    fail("VERIFIER_ISOLATE_SOURCE", `${label} must be valid UTF-8`);
  }
  return source;
}

function requireBoundedBytes(value, label, maximumBytes) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximumBytes) {
    fail("VERIFIER_ISOLATE_INPUT", `${label} must be bounded non-empty bytes`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function requireCoordinate(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    fail("VERIFIER_ISOLATE_COORDINATE", `${label} is invalid`);
  }
  return value;
}

function decodeEnvelope(stdout, stderr, exitCode) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.toString("utf8"));
  } catch {
    const detail = stderr.toString("utf8").trim().slice(0, 512);
    fail(
      "VERIFIER_ISOLATE_OUTPUT",
      `verifier isolate returned invalid output (exit ${exitCode}): ${detail || "no detail"}`,
    );
  }
  if (
    exactObject(envelope) &&
    envelope.ok === false &&
    exactObject(envelope.error) &&
    typeof envelope.error.code === "string" &&
    typeof envelope.error.message === "string"
  ) {
    fail(envelope.error.code, envelope.error.message);
  }
  if (!exactObject(envelope) || envelope.ok !== true || !Object.hasOwn(envelope, "result")) {
    fail("VERIFIER_ISOLATE_OUTPUT", "verifier isolate did not return a successful result envelope");
  }
  return envelope.result;
}

async function executeIsolate(request, { nodeExecutable, timeoutMs }) {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.length > maximumInputBytes) {
    fail("VERIFIER_ISOLATE_INPUT", "verifier-isolate input exceeds its byte bound");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      nodeExecutable,
      [
        "--experimental-vm-modules",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        isolateBootstrap,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {},
      },
    );
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ProbeVerifierIsolateError("VERIFIER_ISOLATE_TIMEOUT", "verifier isolate timed out"),
      );
    }, timeoutMs);
    const collect = (target, chunk, current, label) => {
      const next = current + chunk.length;
      if (next > maximumOutputBytes) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(
            new ProbeVerifierIsolateError(
              "VERIFIER_ISOLATE_OUTPUT_BOUND",
              `${label} exceeded its byte bound`,
            ),
          );
        }
        return current;
      }
      target.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, "stderr");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(decodeEnvelope(Buffer.concat(stdout), Buffer.concat(stderr), code));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function loadRetainedProbeVerifier({
  registrySourceBytes,
  contractSourceBytes,
  transcriptSourceBytes,
  nativeClientSourceBytes,
  nativeManifestDigestSourceBytes,
  nodeExecutable = process.execPath,
  timeoutMs = 10_000,
}) {
  const registrySource = requireSourceBytes(registrySourceBytes, "registrySourceBytes");
  const contractSource = requireSourceBytes(contractSourceBytes, "contractSourceBytes");
  const transcriptSource =
    transcriptSourceBytes === undefined
      ? null
      : requireSourceBytes(transcriptSourceBytes, "transcriptSourceBytes");
  const nativeClientSource =
    nativeClientSourceBytes === undefined
      ? null
      : requireSourceBytes(nativeClientSourceBytes, "nativeClientSourceBytes");
  const nativeManifestDigestSource =
    nativeManifestDigestSourceBytes === undefined
      ? null
      : requireSourceBytes(nativeManifestDigestSourceBytes, "nativeManifestDigestSourceBytes");
  if ((nativeClientSource === null) !== (nativeManifestDigestSource === null)) {
    fail(
      "VERIFIER_ISOLATE_SOURCE",
      "nativeClientSourceBytes and nativeManifestDigestSourceBytes must be provided together",
    );
  }
  if (typeof nodeExecutable !== "string" || nodeExecutable.length === 0) {
    fail("VERIFIER_ISOLATE_NODE", "nodeExecutable must be a non-empty path");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    fail("VERIFIER_ISOLATE_TIMEOUT", "timeoutMs must be between 100 and 60000");
  }
  return Object.freeze({
    async getDefinition(rowId, variantId) {
      return deepFreezeJson(
        await executeIsolate(
          {
            action: "definition",
            registrySource,
            contractSource,
            transcriptSource,
            nativeClientSource,
            nativeManifestDigestSource,
            rowId: requireCoordinate(rowId, "rowId"),
            variantId: requireCoordinate(variantId, "variantId"),
          },
          { nodeExecutable, timeoutMs },
        ),
      );
    },
    async getTranscriptFactDefinition(rowId, variantId) {
      return deepFreezeJson(
        await executeIsolate(
          {
            action: "transcript-fact-definition",
            registrySource,
            contractSource,
            transcriptSource,
            nativeClientSource,
            nativeManifestDigestSource,
            rowId: requireCoordinate(rowId, "rowId"),
            variantId: requireCoordinate(variantId, "variantId"),
          },
          { nodeExecutable, timeoutMs },
        ),
      );
    },
    async verify(input) {
      if (!exactObject(input)) fail("VERIFIER_ISOLATE_INPUT", "verifier input must be an object");
      return deepFreezeJson(
        await executeIsolate(
          {
            action: "verify",
            registrySource,
            contractSource,
            transcriptSource,
            nativeClientSource,
            nativeManifestDigestSource,
            input,
          },
          { nodeExecutable, timeoutMs },
        ),
      );
    },
    async reduceTranscript(input) {
      if (!exactObject(input)) fail("VERIFIER_ISOLATE_INPUT", "transcript input must be an object");
      const sourceTranscriptBytes = requireBoundedBytes(
        input.sourceTranscriptBytes,
        "sourceTranscriptBytes",
        maximumSourceBytes,
      );
      const controllerPublicKeyBytes = requireBoundedBytes(
        input.controllerPublicKeyBytes,
        "controllerPublicKeyBytes",
        64 * 1024,
      );
      if (
        !Array.isArray(input.trustedNativeTranscriptBytes) ||
        input.trustedNativeTranscriptBytes.length === 0
      ) {
        fail("VERIFIER_ISOLATE_INPUT", "trustedNativeTranscriptBytes must be a non-empty array");
      }
      const trustedNativeTranscriptBytes = input.trustedNativeTranscriptBytes.map((bytes, index) =>
        requireBoundedBytes(
          bytes,
          `trustedNativeTranscriptBytes[${index}]`,
          maximumNativeTranscriptBytes,
        ),
      );
      if (!Array.isArray(input.trustedControllerActionAttestationBytes)) {
        fail("VERIFIER_ISOLATE_INPUT", "trustedControllerActionAttestationBytes must be an array");
      }
      let controllerActionAttestationBytesTotal = 0;
      const trustedControllerActionAttestationBytes =
        input.trustedControllerActionAttestationBytes.map((bytes, index) => {
          const retained = requireBoundedBytes(
            bytes,
            `trustedControllerActionAttestationBytes[${index}]`,
            maximumControllerActionAttestationBytes,
          );
          controllerActionAttestationBytesTotal += retained.length;
          if (controllerActionAttestationBytesTotal > maximumControllerActionAttestationBytes) {
            fail(
              "VERIFIER_ISOLATE_INPUT",
              "trusted controller action attestations exceed their total byte bound",
            );
          }
          return retained;
        });
      const {
        sourceTranscriptBytes: _sourceTranscriptBytes,
        controllerPublicKeyBytes: _controllerPublicKeyBytes,
        trustedNativeTranscriptBytes: _trustedNativeTranscriptBytes,
        trustedControllerActionAttestationBytes: _trustedControllerActionAttestationBytes,
        ...jsonInput
      } = input;
      return deepFreezeJson(
        await executeIsolate(
          {
            action: "reduce-transcript",
            registrySource,
            contractSource,
            transcriptSource,
            nativeClientSource,
            nativeManifestDigestSource,
            input: jsonInput,
            sourceTranscriptBytesBase64: sourceTranscriptBytes.toString("base64"),
            controllerPublicKeyBytesBase64: controllerPublicKeyBytes.toString("base64"),
            trustedNativeTranscriptBytesBase64: trustedNativeTranscriptBytes.map((bytes) =>
              bytes.toString("base64"),
            ),
            trustedControllerActionAttestationBytesBase64:
              trustedControllerActionAttestationBytes.map((bytes) => bytes.toString("base64")),
          },
          { nodeExecutable, timeoutMs },
        ),
      );
    },
    async validateNativeTranscript(bytes) {
      const nativeTranscriptBytes = requireBoundedBytes(
        bytes,
        "nativeTranscriptBytes",
        maximumNativeTranscriptBytes,
      );
      return deepFreezeJson(
        await executeIsolate(
          {
            action: "validate-native-transcript",
            registrySource,
            contractSource,
            transcriptSource,
            nativeClientSource,
            nativeManifestDigestSource,
            nativeTranscriptBytesBase64: nativeTranscriptBytes.toString("base64"),
          },
          { nodeExecutable, timeoutMs },
        ),
      );
    },
  });
}

export function assertVerifierSourceDigests({
  registrySourceBytes,
  registrySourceSha256,
  contractSourceBytes,
  contractSourceSha256,
}) {
  for (const [bytes, expected, label] of [
    [registrySourceBytes, registrySourceSha256, "registry"],
    [contractSourceBytes, contractSourceSha256, "contract"],
  ]) {
    requireSourceBytes(bytes, `${label} source`);
    if (typeof expected !== "string" || !sha256Pattern.test(expected)) {
      fail("VERIFIER_ISOLATE_DIGEST", `${label} source digest is invalid`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) fail("VERIFIER_ISOLATE_DIGEST", `${label} source digest mismatches`);
  }
}
