import type { DifferentialBlockmapSummary } from "./verify-differential-blockmap.mjs";

export interface WindowsUpdaterReleaseInput {
  readonly version: string;
  readonly installer: Uint8Array;
  readonly blockmap?: Uint8Array;
  readonly metadata: string | Uint8Array;
}

export interface WindowsUpdaterPreflight {
  readonly feedUrl: string;
  readonly channel: "latest";
  readonly publisherName: string;
  readonly useMultipleRangeRequest: false;
  readonly disableWebInstaller: true;
  readonly verifyUpdateCodeSignature: true;
}

export interface WindowsUpdaterRoundTripResult {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly candidateInstallerName: string;
  readonly candidateInstallerSha512: string;
  readonly candidateInstallerSize: number;
  readonly differential: DifferentialBlockmapSummary | null;
  readonly preflight: WindowsUpdaterPreflight;
  readonly authenticode: "pending-w19";
}

export function verifyWindowsUpdaterRoundTrip(input: {
  readonly baseline: WindowsUpdaterReleaseInput;
  readonly candidate: WindowsUpdaterReleaseInput;
  readonly preflight: WindowsUpdaterPreflight;
}): WindowsUpdaterRoundTripResult;
export function safeWindowsUpdaterRoundTripMessage(error: unknown): string | undefined;
