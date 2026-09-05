export function capturePackagedSelfTest(input: {
  readonly athleteHome: string;
  readonly rpcUrl: string;
  readonly timeoutMs: number;
}): Promise<{
  readonly code: number;
  readonly signal: null;
  readonly stdout: string;
  readonly stderr: string;
}>;
