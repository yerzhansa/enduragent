import type { Stats } from "node:fs";

export const REQUIRED_ELECTRON_FUSES: Readonly<Record<number, number>>;

export interface VerifyElectronFusesOverrides {
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly getCurrentFuseWire?: (path: string) => Promise<Record<number | "version", unknown>>;
}

export function verifyElectronFuses(
  executable: string,
  overrides?: VerifyElectronFusesOverrides,
): Promise<Readonly<{ executable: string; version: unknown }>>;
