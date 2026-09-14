import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { bytesEqual } from "./model-catalog-bytes.js";
import { MODEL_CATALOG_RECORD_MAX_BYTES } from "./model-catalog-constants.js";
import {
  CatalogPublicationError,
  modelCatalogDeploymentReceiptBytes,
  modelCatalogPublicationRecordBytes,
  parseModelCatalogDeploymentReceiptBytes,
  parseModelCatalogPublicationRecordBytes,
  type ModelCatalogDeploymentReceipt,
  type ModelCatalogPublicationRecord,
  type ModelCatalogTarget,
} from "./model-catalog-publication.js";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function archiveRoot(path: string): string {
  const normalized = normalize(path);
  if (!isAbsolute(normalized) || normalized === parse(normalized).root) {
    throw new CatalogPublicationError(
      "validation",
      "--archive must be an absolute non-root directory",
    );
  }
  return normalized;
}

async function readBoundedFile(path: string): Promise<Uint8Array> {
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new CatalogPublicationError("not-found", `${path} was not found`);
    }
    throw error;
  }
  if (fileSize <= 0 || fileSize > MODEL_CATALOG_RECORD_MAX_BYTES) {
    throw new CatalogPublicationError("integrity", `${path} has an invalid size`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== fileSize) {
    throw new CatalogPublicationError("integrity", `${path} changed while it was read`);
  }
  return bytes;
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  let failure: unknown;
  try {
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    let alreadyPresent = false;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!bytesEqual(await readBoundedFile(path), bytes)) {
        throw new CatalogPublicationError("conflict", `${path} already contains different bytes`);
      }
      alreadyPresent = true;
    }
    if (!alreadyPresent && !bytesEqual(await readBoundedFile(path), bytes)) {
      throw new CatalogPublicationError("integrity", `${path} failed immutable read-back`);
    }
  } catch (error) {
    failure = error;
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
}

interface ArchiveLockOwner {
  readonly lockId: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly deploymentStartedAt: number | null;
}

const LOCK_OWNER_FILE = "owner.json";
const DEPLOYMENT_RECOVERY_GRACE_MS = 15 * 60 * 1_000;

function parseLockOwner(input: unknown): ArchiveLockOwner {
  if (typeof input !== "object" || input === null) {
    throw new CatalogPublicationError("conflict", "the model catalog archive lock is invalid");
  }
  const owner = input as Record<string, unknown>;
  if (
    typeof owner.lockId !== "string" ||
    !/^[a-f0-9-]{36}$/iu.test(owner.lockId) ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    !Number.isFinite(owner.createdAt) ||
    (owner.deploymentStartedAt !== null && !Number.isFinite(owner.deploymentStartedAt))
  ) {
    throw new CatalogPublicationError("conflict", "the model catalog archive lock is invalid");
  }
  return {
    lockId: owner.lockId,
    pid: Number(owner.pid),
    createdAt: Number(owner.createdAt),
    deploymentStartedAt:
      owner.deploymentStartedAt === null ? null : Number(owner.deploymentStartedAt),
  };
}

async function acquireRecoveryClaim(lockPath: string): Promise<string> {
  const claimPath = `${lockPath}.recovery`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(claimPath, "wx", 0o600);
      const claim = {
        lockId: randomUUID(),
        pid: process.pid,
        createdAt: Date.now(),
        deploymentStartedAt: null,
      } satisfies ArchiveLockOwner;
      await handle.writeFile(`${JSON.stringify(claim)}\n`);
      await handle.sync();
      return claimPath;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let claim: ArchiveLockOwner | undefined;
      try {
        claim = parseLockOwner(JSON.parse(await readFile(claimPath, "utf8")));
      } catch {
        const claimAge = Date.now() - (await stat(claimPath)).mtimeMs;
        if (claimAge < DEPLOYMENT_RECOVERY_GRACE_MS) {
          throw new CatalogPublicationError("conflict", "archive recovery is already in progress");
        }
      }
      if (
        claim !== undefined &&
        (processIsAlive(claim.pid) || Date.now() - claim.createdAt < DEPLOYMENT_RECOVERY_GRACE_MS)
      ) {
        throw new CatalogPublicationError("conflict", "archive recovery is already in progress");
      }
      try {
        await unlink(claimPath);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      }
    } finally {
      await handle?.close();
    }
  }
  throw new CatalogPublicationError("conflict", "archive recovery could not claim the lock");
}

async function readLockOwner(lockPath: string): Promise<ArchiveLockOwner> {
  try {
    return parseLockOwner(JSON.parse(await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8")));
  } catch (error) {
    if (error instanceof CatalogPublicationError) throw error;
    throw new CatalogPublicationError("conflict", "the model catalog archive lock is invalid");
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function writeLockOwner(lockPath: string, owner: ArchiveLockOwner): Promise<void> {
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  const temporaryPath = `${ownerPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, ownerPath);
}

export class LockedModelCatalogArchive {
  constructor(
    private readonly root: string,
    private readonly lockPath: string,
    private owner: ArchiveLockOwner,
  ) {}

  async markDeploymentStarted(now: number): Promise<void> {
    if (!Number.isFinite(now) || now < 0) {
      throw new CatalogPublicationError("validation", "deployment clock is invalid");
    }
    this.owner = { ...this.owner, deploymentStartedAt: now };
    await writeLockOwner(this.lockPath, this.owner);
  }

  async markDeploymentFinished(): Promise<void> {
    this.owner = { ...this.owner, deploymentStartedAt: null };
    await writeLockOwner(this.lockPath, this.owner);
  }

  private recordPath(revision: number): string {
    return join(this.root, "records", `${revision}.json`);
  }

  private receiptPath(target: ModelCatalogTarget, revision: number): string {
    return join(this.root, "receipts", target, `${revision}.json`);
  }

  async writePublicationRecord(record: ModelCatalogPublicationRecord): Promise<void> {
    const bytes = modelCatalogPublicationRecordBytes(record);
    await writeImmutable(this.recordPath(record.revision), bytes);
    const stored = await this.readPublicationRecord(record.revision);
    if (stored.catalogDigest !== record.catalogDigest) {
      throw new CatalogPublicationError(
        "integrity",
        "archived publication record failed read-back",
      );
    }
  }

  async readPublicationRecord(revision: number): Promise<ModelCatalogPublicationRecord> {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new CatalogPublicationError("validation", "revision must be a positive integer");
    }
    const record = await parseModelCatalogPublicationRecordBytes(
      await readBoundedFile(this.recordPath(revision)),
    );
    if (record.revision !== revision) {
      throw new CatalogPublicationError(
        "integrity",
        "publication record is stored under the wrong revision",
      );
    }
    return record;
  }

  async writeDeploymentReceipt(receipt: ModelCatalogDeploymentReceipt): Promise<void> {
    await writeImmutable(
      this.receiptPath(receipt.target, receipt.revision),
      modelCatalogDeploymentReceiptBytes(receipt),
    );
    const stored = await this.readDeploymentReceipt(receipt.target, receipt.revision);
    if (stored.catalogDigest !== receipt.catalogDigest) {
      throw new CatalogPublicationError(
        "integrity",
        "archived deployment receipt failed read-back",
      );
    }
  }

  async readDeploymentReceipt(
    target: ModelCatalogTarget,
    revision: number,
  ): Promise<ModelCatalogDeploymentReceipt> {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new CatalogPublicationError("validation", "revision must be a positive integer");
    }
    const receipt = parseModelCatalogDeploymentReceiptBytes(
      await readBoundedFile(this.receiptPath(target, revision)),
    );
    if (receipt.target !== target || receipt.revision !== revision) {
      throw new CatalogPublicationError(
        "integrity",
        "deployment receipt is stored under the wrong target",
      );
    }
    return receipt;
  }

  async inventory(): Promise<readonly string[]> {
    const visit = async (directory: string, prefix: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      const paths: string[] = [];
      for (const entry of entries) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory())
          paths.push(...(await visit(join(directory, entry.name), relative)));
        else paths.push(relative);
      }
      return paths.sort();
    };
    return visit(this.root, "");
  }
}

export class ModelCatalogArchive {
  readonly root: string;

  constructor(path: string) {
    this.root = archiveRoot(path);
  }

  async withExclusiveLock<T>(
    action: (archive: LockedModelCatalogArchive) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, ".publication.lock");
    let recoveryClaimPath: string | undefined;
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const observedLock = await stat(lockPath);
      let owner: ArchiveLockOwner | undefined;
      try {
        owner = await readLockOwner(lockPath);
      } catch (ownerError) {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge < DEPLOYMENT_RECOVERY_GRACE_MS) throw ownerError;
      }
      if (
        owner !== undefined &&
        (processIsAlive(owner.pid) ||
          (owner.deploymentStartedAt !== null &&
            Date.now() - owner.deploymentStartedAt < DEPLOYMENT_RECOVERY_GRACE_MS))
      ) {
        throw new CatalogPublicationError("conflict", "the model catalog archive is locked");
      }
      recoveryClaimPath = await acquireRecoveryClaim(lockPath);
      const currentLock = await stat(lockPath);
      if (currentLock.dev !== observedLock.dev || currentLock.ino !== observedLock.ino) {
        await unlink(recoveryClaimPath);
        throw new CatalogPublicationError("conflict", "the model catalog archive lock changed");
      }
      let currentOwner: ArchiveLockOwner | undefined;
      try {
        currentOwner = await readLockOwner(lockPath);
      } catch {
        currentOwner = undefined;
      }
      if (
        (owner !== undefined && currentOwner?.lockId !== owner.lockId) ||
        (owner === undefined &&
          currentOwner !== undefined &&
          (processIsAlive(currentOwner.pid) ||
            Date.now() - currentOwner.createdAt < DEPLOYMENT_RECOVERY_GRACE_MS))
      ) {
        await unlink(recoveryClaimPath);
        throw new CatalogPublicationError("conflict", "the model catalog archive lock changed");
      }
      const abandonedPath = `${lockPath}.abandoned-${randomUUID()}`;
      try {
        await rename(lockPath, abandonedPath);
      } catch (renameError) {
        await unlink(recoveryClaimPath);
        if (errorCode(renameError) === "ENOENT") {
          throw new CatalogPublicationError("conflict", "the model catalog archive lock changed");
        }
        throw renameError;
      }
      await rm(abandonedPath, { recursive: true });
      await mkdir(lockPath, { mode: 0o700 });
    }
    const owner: ArchiveLockOwner = {
      lockId: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      deploymentStartedAt: null,
    };
    try {
      await writeLockOwner(lockPath, owner);
      if (recoveryClaimPath !== undefined) await unlink(recoveryClaimPath);
    } catch (error) {
      if (recoveryClaimPath !== undefined) {
        try {
          await unlink(recoveryClaimPath);
        } catch (unlinkError) {
          if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
        }
      }
      await rm(lockPath, { recursive: true });
      throw error;
    }
    const outcome = await action(new LockedModelCatalogArchive(this.root, lockPath, owner)).then(
      (value) => ({ kind: "success", value }) as const,
      (error: unknown) => ({ kind: "failure", error }) as const,
    );
    let releaseError: unknown;
    try {
      const releasedOwner = await readLockOwner(lockPath);
      if (releasedOwner.lockId !== owner.lockId || releasedOwner.pid !== owner.pid) {
        throw new CatalogPublicationError("conflict", "the model catalog archive lock changed");
      }
      await unlink(join(lockPath, LOCK_OWNER_FILE));
      await rmdir(lockPath);
    } catch (error) {
      releaseError = error;
    }
    if (outcome.kind === "failure") throw outcome.error;
    if (releaseError !== undefined) throw releaseError;
    return outcome.value;
  }
}
