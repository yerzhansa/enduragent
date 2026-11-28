export interface ParsedBlockmapFile {
  readonly name: "file";
  readonly offset: 0;
  readonly checksums: readonly string[];
  readonly sizes: readonly number[];
}

export interface ParsedBlockmap {
  readonly version: "2";
  readonly files: readonly [ParsedBlockmapFile];
}

export interface VerifyDifferentialBlockmapOptions {
  readonly oldArtifact?: Uint8Array;
  readonly newArtifact?: Uint8Array;
  readonly minimumReuseRatio?: number;
}

export interface DifferentialBlockmapSummary {
  readonly totalBytes: number;
  readonly copyBytes: number;
  readonly downloadBytes: number;
  readonly copyOperations: number;
  readonly downloadOperations: number;
  readonly reuseRatio: number;
}

export function safeDifferentialBlockmapVerificationMessage(error: unknown): string | undefined;
export function parseGzipBlockmap(bytes: Uint8Array, label?: string): ParsedBlockmap;
export function verifyDifferentialBlockmap(
  oldBlockmapBytes: Uint8Array,
  newBlockmapBytes: Uint8Array,
  options?: VerifyDifferentialBlockmapOptions,
): DifferentialBlockmapSummary;
