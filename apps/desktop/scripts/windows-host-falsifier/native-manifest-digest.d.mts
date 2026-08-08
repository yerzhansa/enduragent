export interface NativeManifestNamedDigest {
  readonly name: string;
  readonly sha256: string;
}

export interface NativeManifestSourceDigestComponent extends NativeManifestNamedDigest {
  readonly bytes: number;
}

export interface NativeManifestToolchainDigestComponents {
  readonly schemaVersion: number;
  readonly powerShellVersion: string;
  readonly powerShellEdition: string;
  readonly clrVersion: string;
  readonly codeDomProvider: string;
  readonly codeDomProviderAssemblyVersion: string;
  readonly cscFileVersion: string;
  readonly cscSha256Before: string;
  readonly cscSha256After: string;
  readonly powerShellExecutableSha256Before: string;
  readonly powerShellExecutableSha256After: string;
  readonly runtimeDirectorySha256Before: string;
  readonly runtimeDirectorySha256After: string;
  readonly runtimeRelativeInventory: readonly string[];
  readonly outputType: string;
  readonly platform: string;
  readonly compilerOptions: string;
  readonly addTypeInvocation: string;
  readonly referenceSha256Before: readonly NativeManifestNamedDigest[];
  readonly referenceSha256After: readonly NativeManifestNamedDigest[];
}

export interface NativeManifestCandidateDigestComponents {
  readonly sourceBundleSha256: string;
  readonly assemblySha256: string;
  readonly toolchainDigest: string;
}

export interface NativeManifestDigests {
  readonly sourceBundleSha256: string;
  readonly toolchainDigest: string;
  readonly candidateDigest: string;
}

export function deriveNativeSourceBundleSha256(
  sources: readonly NativeManifestSourceDigestComponent[],
): string;

export function deriveNativeToolchainDigest(
  toolchain: NativeManifestToolchainDigestComponents,
): string;

export function deriveNativeCandidateDigest(
  components: NativeManifestCandidateDigestComponents,
): string;

export function deriveNativeManifestDigests(components: {
  readonly sources: readonly NativeManifestSourceDigestComponent[];
  readonly toolchain: NativeManifestToolchainDigestComponents;
  readonly assemblySha256: string;
}): NativeManifestDigests;
