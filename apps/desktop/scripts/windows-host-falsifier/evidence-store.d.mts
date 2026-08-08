export class EvidenceStoreError extends Error {
  readonly code: string;
}

export interface EvidenceArtifactHash {
  readonly path: string;
  readonly sha256: string;
}

export interface EvidenceStore {
  readonly root: string;
  createDirectory(relativePath: string): Promise<string>;
  writeBytes(relativePath: string, value: Uint8Array | string): Promise<EvidenceArtifactHash>;
  writeCanonicalJson(
    relativePath: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<EvidenceArtifactHash>;
  readArtifact(relativePath: string): Promise<{
    readonly path: string;
    readonly bytes: Buffer;
    readonly size: number;
    readonly sha256: string;
  }>;
  verifyArtifactSet(
    declarations: readonly EvidenceArtifactHash[],
  ): Promise<readonly EvidenceArtifactHash[]>;
  scan(): Promise<{
    readonly files: number;
    readonly totalBytes: number;
    readonly artifacts: readonly (EvidenceArtifactHash & { readonly bytes: number })[];
  }>;
  list(relativePath: string): Promise<
    readonly {
      readonly name: string;
      readonly kind: "directory" | "file";
    }[]
  >;
  assertRootStable(): Promise<void>;
}

export function validateEvidenceRelativePath(value: string): string;
export function openEvidenceStore(options: {
  readonly root: string;
  readonly sentinel?: string;
  readonly limits?: Partial<{
    readonly maxArtifactBytes: number;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
    readonly maxDepth: number;
  }>;
}): Promise<EvidenceStore>;
export function hashEvidenceValue(domain: string, value: unknown): string;
export function sealEvidenceTree(store: EvidenceStore): Promise<{
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-evidence-tree";
  readonly files: number;
  readonly totalBytes: number;
  readonly artifacts: readonly (EvidenceArtifactHash & { readonly bytes: number })[];
  readonly treeSha256: string;
}>;
