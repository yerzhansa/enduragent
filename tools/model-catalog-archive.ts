import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const LOCK_DATABASE_FILE = ".publication-lock.sqlite";
const DEPLOYMENT_MARKER_FILE = ".deployment-in-progress.json";
const DEPLOYMENT_RECOVERY_GRACE_MS = 15 * 60 * 1_000;

function sqliteIsLocked(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === 5
  );
}

async function clearInterruptedDeployment(markerPath: string): Promise<void> {
  let age: number;
  try {
    const markerStat = await stat(markerPath);
    age = Date.now() - markerStat.mtimeMs;
    try {
      const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      if (Number.isFinite(parsed.startedAt)) age = Date.now() - Number(parsed.startedAt);
    } catch {
      age = Date.now() - markerStat.mtimeMs;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (age < DEPLOYMENT_RECOVERY_GRACE_MS) {
    throw new CatalogPublicationError(
      "conflict",
      "an interrupted model catalog deployment may still be running",
    );
  }
  await unlink(markerPath);
}

export class LockedModelCatalogArchive {
  constructor(
    private readonly root: string,
    private readonly deploymentMarkerPath: string,
  ) {}

  async markDeploymentStarted(now: number): Promise<void> {
    if (!Number.isFinite(now) || now < 0) {
      throw new CatalogPublicationError("validation", "deployment clock is invalid");
    }
    const temporaryPath = `${this.deploymentMarkerPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ startedAt: now })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, this.deploymentMarkerPath);
  }

  async markDeploymentFinished(): Promise<void> {
    try {
      await unlink(this.deploymentMarkerPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
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
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(this.root, LOCK_DATABASE_FILE));
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch (error) {
      try {
        database?.close();
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED"))) throw error;
      }
      if (sqliteIsLocked(error)) {
        throw new CatalogPublicationError("conflict", "the model catalog archive is locked");
      }
      throw error;
    }
    const deploymentMarkerPath = join(this.root, DEPLOYMENT_MARKER_FILE);
    const outcome = await clearInterruptedDeployment(deploymentMarkerPath)
      .then(() => action(new LockedModelCatalogArchive(this.root, deploymentMarkerPath)))
      .then(
        (value) => ({ kind: "success", value }) as const,
        (error: unknown) => ({ kind: "failure", error }) as const,
      );
    let releaseError: unknown;
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      releaseError = error;
    }
    try {
      database.close();
    } catch (error) {
      if (releaseError === undefined) releaseError = error;
    }
    if (outcome.kind === "failure") throw outcome.error;
    if (releaseError !== undefined) throw releaseError;
    return outcome.value;
  }
}
