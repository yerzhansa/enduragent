import { DESKTOP_OAUTH_ENVELOPE_FILE } from "./oauth-credential-owner.js";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { CREDENTIAL_FILE_MODE, DESKTOP_CREDENTIAL_SLOTS } from "./credential-vault.js";
import {
  KEYCHAIN_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./credential-envelope-format.js";
import {
  inspectCredentialEnvelopeTarget,
  type CredentialEnvelopeInspection,
  type CredentialEnvelopeTarget,
  type CredentialEnvelopeVault,
} from "./credential-envelope-inspection.js";
import {
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_DESIRED_STATE_FILE_NAME,
  TELEGRAM_PROFILE_FILE_NAME,
} from "./telegram-credential-vault.js";
import { TELEGRAM_POWER_STATE_FILE_NAME } from "./telegram-power.js";
export {
  classifyCredentialEnvelopeRemoval,
  inspectCredentialEnvelopeTarget,
} from "./credential-envelope-inspection.js";
export type {
  CredentialEnvelopeInspection,
  CredentialEnvelopeRemovalState,
  CredentialEnvelopeTarget,
  CredentialEnvelopeVault,
  InspectCredentialEnvelopeTargetOptions,
} from "./credential-envelope-inspection.js";

export const CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT = 256;

export interface CredentialEnvelopeRef extends CredentialEnvelopeTarget {
  readonly keyId: number | undefined;
}

export interface UnexplainedCredentialVaultEntry {
  readonly vault: CredentialEnvelopeVault;
  readonly root: string;
  readonly fileName: string;
}

export interface CredentialEnvelopeInventory {
  readonly deletionBlockers: readonly CredentialEnvelopeRef[];
  readonly unexplainedDeletionBlockers: readonly UnexplainedCredentialVaultEntry[];
  readonly keychainDependents: number;
  readonly unverified: number;
}

export interface CredentialEnvelopeRoots {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly readEnvelopeFile?: (path: string) => Promise<Buffer>;
  readonly inspectEnvelopeTarget?: (
    target: CredentialEnvelopeTarget,
  ) => Promise<CredentialEnvelopeInspection>;
  readonly readEnvelopeDirectory?: (path: string) => Promise<string[]>;
}

export async function readCredentialEnvelopeDirectory(root: string): Promise<string[]> {
  const directory = await opendir(root);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT) {
        throw new RangeError("credential envelope directory entry limit exceeded");
      }
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries.sort();
}

export function credentialEnvelopeTargets(
  roots: CredentialEnvelopeRoots,
): readonly CredentialEnvelopeTarget[] {
  return [
    {
      vault: "credentials",
      root: roots.credentialRoot,
      fileName: DESKTOP_OAUTH_ENVELOPE_FILE,
      mode: CREDENTIAL_FILE_MODE,
    },
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
    for (const slot of [...DESKTOP_CREDENTIAL_SLOTS, "oauth"]) {
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

function knownNonEnvelopeTelegramEntryName(entry: string): boolean {
  for (const [fileName, suffixes] of [
    [TELEGRAM_DESIRED_STATE_FILE_NAME, [".tmp", ".deleted"]],
    [TELEGRAM_POWER_STATE_FILE_NAME, [".tmp"]],
  ] as const) {
    if (entry === fileName) return true;
    const prefix = `.${fileName}.`;
    if (!entry.startsWith(prefix)) continue;
    for (const suffix of suffixes) {
      if (!entry.endsWith(suffix)) continue;
      const id = entry.slice(prefix.length, -suffix.length);
      if (/^[A-Za-z0-9-]{1,128}$/.test(id)) return true;
    }
  }
  return false;
}

async function isVerifiedNonEnvelopeTelegramEntry(
  root: string,
  entry: string,
  inspect: (target: CredentialEnvelopeTarget) => Promise<CredentialEnvelopeInspection>,
): Promise<boolean> {
  let inspected: CredentialEnvelopeInspection;
  try {
    inspected = await inspect({
      vault: "telegram",
      root,
      fileName: entry,
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
  } catch {
    return false;
  }
  if (inspected.status !== "readable") return false;
  try {
    return readCredentialEnvelopeKeyId(inspected.contents) !== KEYCHAIN_ENVELOPE_KEY_ID;
  } finally {
    inspected.contents.fill(0);
  }
}

function canonicalEnvelopeEntry(
  roots: CredentialEnvelopeRoots,
  root: string,
  entry: string,
): boolean {
  return credentialEnvelopeTargets(roots).some(
    (target) => target.root === root && target.fileName === entry,
  );
}

function credentialEnvelopeVaultForRoot(
  roots: CredentialEnvelopeRoots,
  root: string,
): CredentialEnvelopeVault {
  return root === roots.credentialRoot ? "credentials" : "telegram";
}

async function inspectEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  inspect: (target: CredentialEnvelopeTarget) => Promise<CredentialEnvelopeInspection>,
): Promise<CredentialEnvelopeRef | undefined> {
  let inspected: CredentialEnvelopeInspection;
  try {
    inspected = await inspect(target);
  } catch {
    return { ...target, keyId: undefined };
  }
  if (inspected.status === "missing") return undefined;
  if (inspected.status === "blocked") return { ...target, keyId: undefined };
  try {
    return { ...target, keyId: readCredentialEnvelopeKeyId(inspected.contents) };
  } finally {
    inspected.contents.fill(0);
  }
}

function injectedEnvelopeInspector(
  read: (path: string) => Promise<Buffer>,
): (target: CredentialEnvelopeTarget) => Promise<CredentialEnvelopeInspection> {
  return async (target) => {
    try {
      return { status: "readable", contents: await read(join(target.root, target.fileName)) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "blocked" };
    }
  };
}

export async function scanCredentialEnvelopes(
  roots: CredentialEnvelopeRoots,
): Promise<CredentialEnvelopeInventory> {
  const inspect =
    roots.inspectEnvelopeTarget ??
    (roots.readEnvelopeFile === undefined
      ? inspectCredentialEnvelopeTarget
      : injectedEnvelopeInspector(roots.readEnvelopeFile));
  const readDirectory = roots.readEnvelopeDirectory ?? readCredentialEnvelopeDirectory;
  const deletionBlockers: CredentialEnvelopeRef[] = [];
  const unexplainedDeletionBlockers: UnexplainedCredentialVaultEntry[] = [];
  const canonicalEnvelopes: CredentialEnvelopeRef[] = [];
  const missingCanonicalTargets: CredentialEnvelopeTarget[] = [];
  for (const target of credentialEnvelopeTargets(roots)) {
    const inspected = await inspectEnvelopeTarget(target, inspect);
    if (inspected !== undefined) {
      deletionBlockers.push(inspected);
      canonicalEnvelopes.push(inspected);
    } else {
      missingCanonicalTargets.push(target);
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
    if (entries.length > CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT) {
      throw new RangeError("credential envelope directory entry limit exceeded");
    }
    for (const entry of entries) {
      if (canonicalEnvelopeEntry(roots, root, entry)) continue;
      const target = transientCredentialEnvelopeTarget(roots, root, entry);
      if (target !== undefined) {
        const inspected = await inspectEnvelopeTarget(target, inspect);
        if (inspected !== undefined) deletionBlockers.push(inspected);
        continue;
      }
      if (
        root === roots.telegramRoot &&
        knownNonEnvelopeTelegramEntryName(entry) &&
        (await isVerifiedNonEnvelopeTelegramEntry(root, entry, inspect))
      ) {
        continue;
      }
      unexplainedDeletionBlockers.push({
        vault: credentialEnvelopeVaultForRoot(roots, root),
        root,
        fileName: entry,
      });
    }
  }
  for (const target of missingCanonicalTargets) {
    const inspected = await inspectEnvelopeTarget(target, inspect);
    if (inspected !== undefined) {
      deletionBlockers.push(inspected);
      canonicalEnvelopes.push(inspected);
    }
  }
  const keychainDependents = deletionBlockers.filter(
    (blocker) => blocker.keyId === KEYCHAIN_ENVELOPE_KEY_ID,
  ).length;
  return {
    deletionBlockers,
    unexplainedDeletionBlockers,
    keychainDependents,
    unverified: canonicalEnvelopes.filter((envelope) => envelope.keyId !== KEYCHAIN_ENVELOPE_KEY_ID)
      .length,
  };
}
