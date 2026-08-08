import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

function framedDigest(...fields) {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(String(field), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function deriveNativeSourceBundleSha256(sources) {
  return framedDigest(
    "enduragent.windows-native-source-bundle.v1",
    ...sources.flatMap((source) => [source.name, source.sha256, source.bytes]),
  );
}

export function deriveNativeToolchainDigest(toolchain) {
  return framedDigest(
    "enduragent.windows-native-toolchain.v1",
    toolchain.schemaVersion,
    toolchain.powerShellVersion,
    toolchain.powerShellEdition,
    toolchain.clrVersion,
    toolchain.codeDomProvider,
    toolchain.codeDomProviderAssemblyVersion,
    toolchain.cscFileVersion,
    toolchain.cscSha256Before,
    toolchain.cscSha256After,
    toolchain.powerShellExecutableSha256Before,
    toolchain.powerShellExecutableSha256After,
    toolchain.runtimeDirectorySha256Before,
    toolchain.runtimeDirectorySha256After,
    ...toolchain.runtimeRelativeInventory,
    toolchain.outputType,
    toolchain.platform,
    toolchain.compilerOptions,
    toolchain.addTypeInvocation,
    ...toolchain.referenceSha256Before.flatMap((entry) => [entry.name, entry.sha256]),
    ...toolchain.referenceSha256After.flatMap((entry) => [entry.name, entry.sha256]),
  );
}

export function deriveNativeCandidateDigest({
  sourceBundleSha256,
  assemblySha256,
  toolchainDigest,
}) {
  return framedDigest(
    "enduragent.windows-native-candidate.v1",
    sourceBundleSha256,
    assemblySha256,
    toolchainDigest,
  );
}

export function deriveNativeManifestDigests({ sources, toolchain, assemblySha256 }) {
  const sourceBundleSha256 = deriveNativeSourceBundleSha256(sources);
  const toolchainDigest = deriveNativeToolchainDigest(toolchain);
  const candidateDigest = deriveNativeCandidateDigest({
    sourceBundleSha256,
    assemblySha256,
    toolchainDigest,
  });
  return Object.freeze({ sourceBundleSha256, toolchainDigest, candidateDigest });
}
