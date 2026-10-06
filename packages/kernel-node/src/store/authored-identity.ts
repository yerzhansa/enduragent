import { randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeTempThenPublish } from "../lock/write-temp.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIMESTAMP = 0xffffffffffff;
const RANDOM_MASK = (1n << 80n) - 1n;
const deviceIdQueues = new Map<string, Promise<string>>();

export interface AuthoredIdentity {
  deviceId(): Promise<string>;
  newUlid(): string;
  hlcStamp(): { readonly physicalMs: number; readonly counter: number };
}

export interface AuthoredIdentityDependencies {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

function encodeUlid(timestamp: number, randomness: bigint): string {
  let value = (BigInt(timestamp) << 80n) | randomness;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function randomValue(bytes: Uint8Array): bigint {
  if (bytes.length !== 10) throw new TypeError("ULID randomness is invalid");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function createAuthoredIdentity(
  configDir: string,
  dependencies: AuthoredIdentityDependencies = {},
): AuthoredIdentity {
  if (typeof configDir !== "string" || configDir.length === 0) {
    throw new TypeError("authored identity directory is invalid");
  }
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const deviceIdPath = join(configDir, "device-id");
  let lastUlidTimestamp = -1;
  let lastUlidRandomness = 0n;
  let lastHlcPhysical = -1;
  let lastHlcCounter = 0;

  const currentTime = (): number => {
    const value = Math.floor(now());
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
      throw new TypeError("authored identity clock is invalid");
    }
    return value;
  };

  const nextUlid = (): string => {
    const observed = currentTime();
    let timestamp = observed;
    let randomness: bigint;
    if (observed > lastUlidTimestamp) {
      randomness = randomValue(randomBytes(10));
    } else {
      timestamp = lastUlidTimestamp;
      randomness = lastUlidRandomness + 1n;
      if (randomness > RANDOM_MASK) {
        if (timestamp === MAX_TIMESTAMP) throw new Error("ULID space is exhausted");
        timestamp += 1;
        randomness = 0n;
      }
    }
    lastUlidTimestamp = timestamp;
    lastUlidRandomness = randomness;
    return encodeUlid(timestamp, randomness);
  };

  const loadOrCreateDeviceId = async (): Promise<string> => {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    try {
      const existing = (await readFile(deviceIdPath, "utf8")).trim();
      if (existing.length > 0) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const generated = nextUlid();
    await writeTempThenPublish(deviceIdPath, `${generated}\n`, rename);
    return generated;
  };

  return {
    deviceId() {
      const previous = deviceIdQueues.get(deviceIdPath) ?? Promise.resolve("");
      const current = previous.then(loadOrCreateDeviceId, loadOrCreateDeviceId);
      deviceIdQueues.set(deviceIdPath, current);
      void current
        .finally(() => {
          if (deviceIdQueues.get(deviceIdPath) === current) deviceIdQueues.delete(deviceIdPath);
        })
        .catch(() => {});
      return current;
    },
    newUlid: nextUlid,
    hlcStamp() {
      const observed = currentTime();
      if (observed > lastHlcPhysical) {
        lastHlcPhysical = observed;
        lastHlcCounter = 0;
      } else {
        lastHlcCounter += 1;
        if (!Number.isSafeInteger(lastHlcCounter)) throw new Error("HLC counter is exhausted");
      }
      return { physicalMs: lastHlcPhysical, counter: lastHlcCounter };
    },
  };
}
