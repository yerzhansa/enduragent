import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CREDENTIAL_FILE_MODE, DESKTOP_CREDENTIAL_SLOTS } from "./credential-vault.js";
import {
  KEYCHAIN_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./keychain-credential-encryption.js";
import {
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_PROFILE_FILE_NAME,
} from "./telegram-credential-vault.js";

export type CredentialEnvelopeVault = "credentials" | "telegram";

export interface CredentialEnvelopeTarget {
  readonly vault: CredentialEnvelopeVault;
  readonly root: string;
  readonly fileName: string;
  readonly mode: number;
}

export interface CredentialEnvelopeRef extends CredentialEnvelopeTarget {
  readonly keyId: number | undefined;
}

export interface CredentialEnvelopeInventory {
  readonly deletionBlockers: readonly CredentialEnvelopeRef[];
  readonly keychainDependents: number;
  readonly unverified: number;
}

export interface CredentialEnvelopeRoots {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly readEnvelopeFile?: (path: string) => Promise<Buffer>;
  readonly readEnvelopeDirectory?: (path: string) => Promise<string[]>;
}

export function credentialEnvelopeTargets(
  roots: CredentialEnvelopeRoots,
): readonly CredentialEnvelopeTarget[] {
  return [
    ...DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
      vault: "credentials" as const,
      root: roots.credentialRoot,
      fileName: `${slot}.bin`,
      mode: CREDENTIAL_FILE_MODE,
    })),
    {
      vault: "telegram" as const,
      root: roots.telegramRoot,
      fileName: TELEGRAM_PROFILE_FILE_NAME,
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    },
  ];
}

export function credentialEnvelopeKeyId(envelope: Buffer): number | undefined {
  return readCredentialEnvelopeKeyId(envelope);
}

function transientCredentialEnvelopeTarget(
  roots: CredentialEnvelopeRoots,
  root: string,
  entry: string,
): CredentialEnvelopeTarget | undefined {
  if (root === roots.credentialRoot) {
    for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
      for (const prefix of [`.${slot}.`, `.${slot}.bin.`]) {
        if (!entry.startsWith(prefix)) continue;
        for (const suffix of [".tmp", ".deleted"]) {
          if (!entry.endsWith(suffix)) continue;
          const id = entry.slice(prefix.length, -suffix.length);
          if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
            return {
              vault: "credentials",
              root,
              fileName: entry,
              mode: CREDENTIAL_FILE_MODE,
            };
          }
        }
      }
    }
    return undefined;
  }
  if (root !== roots.telegramRoot) return undefined;
  const prefix = `.${TELEGRAM_PROFILE_FILE_NAME}.`;
  if (!entry.startsWith(prefix)) return undefined;
  for (const suffix of [".tmp", ".deleted"]) {
    if (!entry.endsWith(suffix)) continue;
    const id = entry.slice(prefix.length, -suffix.length);
    if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      return {
        vault: "telegram",
        root,
        fileName: entry,
        mode: TELEGRAM_CREDENTIAL_FILE_MODE,
      };
    }
  }
  return undefined;
}

async function inspectEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  read: (path: string) => Promise<Buffer>,
): Promise<CredentialEnvelopeRef | undefined> {
  let contents: Buffer | undefined;
  try {
    contents = await read(join(target.root, target.fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { ...target, keyId: undefined };
  }
  try {
    return { ...target, keyId: readCredentialEnvelopeKeyId(contents) };
  } finally {
    contents.fill(0);
  }
}

export async function scanCredentialEnvelopes(
  roots: CredentialEnvelopeRoots,
): Promise<CredentialEnvelopeInventory> {
  const read = roots.readEnvelopeFile ?? ((path: string) => readFile(path));
  const readDirectory = roots.readEnvelopeDirectory ?? readdir;
  const deletionBlockers: CredentialEnvelopeRef[] = [];
  const canonicalEnvelopes: CredentialEnvelopeRef[] = [];
  for (const target of credentialEnvelopeTargets(roots)) {
    const inspected = await inspectEnvelopeTarget(target, read);
    if (inspected !== undefined) {
      deletionBlockers.push(inspected);
      canonicalEnvelopes.push(inspected);
    }
  }
  for (const root of new Set([roots.credentialRoot, roots.telegramRoot])) {
    let entries: string[];
    try {
      entries = await readDirectory(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = transientCredentialEnvelopeTarget(roots, root, entry);
      if (target === undefined) continue;
      const inspected = await inspectEnvelopeTarget(target, read);
      if (inspected !== undefined) deletionBlockers.push(inspected);
    }
  }
  const keychainDependents = deletionBlockers.filter(
    (blocker) => blocker.keyId === KEYCHAIN_ENVELOPE_KEY_ID,
  ).length;
  return {
    deletionBlockers,
    keychainDependents,
    unverified: canonicalEnvelopes.filter(
      (envelope) => envelope.keyId !== KEYCHAIN_ENVELOPE_KEY_ID,
    ).length,
  };
}
