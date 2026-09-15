import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS } from "../src/model-catalog-owner.js";
import {
  startCountedHttpServer,
  startCountedHttpsServer,
  type CountedHttpServer,
  type CountedHttpsServerCredentials,
} from "./helpers/counted-http-server.js";

const childFixture = fileURLToPath(
  new URL("./fixtures/model-catalog-owner-child.ts", import.meta.url),
);
const children: ChildProcess[] = [];
const directories: string[] = [];
const servers: CountedHttpServer[] = [];
const baseTime = Date.parse("1998-01-01T00:00:00.000Z");

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function candidate() {
  const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
  snapshot.revision = 2;
  snapshot.provenance = { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" };
  return snapshot;
}

interface CertificateAuthority {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
}

interface HttpsTestCertificates {
  readonly trustedCaPath: string;
  readonly valid: CountedHttpsServerCredentials;
  readonly wrongHostname: CountedHttpsServerCredentials;
}

function runOpenSsl(directory: string, arguments_: readonly string[]): void {
  execFileSync("openssl", arguments_, { cwd: directory, stdio: "pipe" });
}

function createCertificateAuthority(
  directory: string,
  name: string,
  commonName: string,
): CertificateAuthority {
  const configPath = join(directory, `${name}.cnf`);
  const certificatePath = join(directory, `${name}.pem`);
  const privateKeyPath = join(directory, `${name}.key`);
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name = subject\nx509_extensions = ca_extensions\nprompt = no\n\n[subject]\nCN = ${commonName}\n\n[ca_extensions]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always,issuer\n`,
  );
  runOpenSsl(directory, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-config",
    configPath,
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
  ]);
  return { certificatePath, privateKeyPath };
}

function createServerCertificate(input: {
  authority: CertificateAuthority;
  commonName: string;
  directory: string;
  name: string;
  serial: number;
  subjectAlternativeName: "DNS:wrong-host.invalid" | "IP:127.0.0.1";
}): CountedHttpsServerCredentials {
  const requestConfigPath = join(input.directory, `${input.name}-request.cnf`);
  const extensionsConfigPath = join(input.directory, `${input.name}-extensions.cnf`);
  const requestPath = join(input.directory, `${input.name}.csr`);
  const certificatePath = join(input.directory, `${input.name}.pem`);
  const privateKeyPath = join(input.directory, `${input.name}.key`);
  writeFileSync(
    requestConfigPath,
    `[req]\ndistinguished_name = subject\nreq_extensions = request_extensions\nprompt = no\n\n[subject]\nCN = ${input.commonName}\n\n[request_extensions]\nsubjectAltName = ${input.subjectAlternativeName}\n`,
  );
  writeFileSync(
    extensionsConfigPath,
    `[server_extensions]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = ${input.subjectAlternativeName}\n`,
  );
  runOpenSsl(input.directory, [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-config",
    requestConfigPath,
    "-keyout",
    privateKeyPath,
    "-out",
    requestPath,
  ]);
  runOpenSsl(input.directory, [
    "x509",
    "-req",
    "-in",
    requestPath,
    "-CA",
    input.authority.certificatePath,
    "-CAkey",
    input.authority.privateKeyPath,
    "-set_serial",
    String(input.serial),
    "-sha256",
    "-days",
    "1",
    "-extfile",
    extensionsConfigPath,
    "-extensions",
    "server_extensions",
    "-out",
    certificatePath,
  ]);
  return {
    certificate: `${readFileSync(certificatePath, "utf8")}${readFileSync(
      input.authority.certificatePath,
      "utf8",
    )}`,
    hostname: "127.0.0.1",
    privateKey: readFileSync(privateKeyPath, "utf8"),
  };
}

function createHttpsTestCertificates(directory: string): HttpsTestCertificates {
  const trustedAuthority = createCertificateAuthority(
    directory,
    "trusted-ca",
    "Enduragent Catalog Test CA",
  );
  return {
    trustedCaPath: trustedAuthority.certificatePath,
    valid: createServerCertificate({
      authority: trustedAuthority,
      commonName: "127.0.0.1",
      directory,
      name: "trusted-loopback",
      serial: 1,
      subjectAlternativeName: "IP:127.0.0.1",
    }),
    wrongHostname: createServerCertificate({
      authority: trustedAuthority,
      commonName: "wrong-host.invalid",
      directory,
      name: "trusted-wrong-host",
      serial: 2,
      subjectAlternativeName: "DNS:wrong-host.invalid",
    }),
  };
}

function childEnvironment(extraCaCertificatePath: string | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_EXTRA_CA_CERTS;
  if (extraCaCertificatePath !== undefined) {
    environment.NODE_EXTRA_CA_CERTS = extraCaCertificatePath;
  }
  return environment;
}

function runChild(input: {
  cacheDirectory: string;
  elapsedNow?: number;
  endpoint: string;
  extraCaCertificatePath?: string;
  installationRoot: string;
  mode?: "read" | "select" | "refresh" | "pause-after-claim" | "refresh-and-hold";
  now?: number;
  readyPath?: string;
  releasePath?: string;
}): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childFixture,
      input.mode ?? "refresh",
      input.installationRoot,
      input.cacheDirectory,
      input.endpoint,
      String(input.now ?? baseTime),
      input.readyPath ?? "",
      input.releasePath ?? "",
      input.elapsedNow === undefined ? "" : String(input.elapsedNow),
    ],
    {
      cwd: process.cwd(),
      env: childEnvironment(input.extraCaCertificatePath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  return child;
}

async function childOutput(child: ChildProcess, allowFailure = false): Promise<string> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!allowFailure && child.exitCode !== 0) {
      throw new Error(`Child exited ${child.exitCode ?? child.signalCode}: ${stderr}`);
    }
    return stdout.trim();
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (allowFailure || code === 0) resolve();
      else reject(new Error(`Child exited ${code ?? signal}: ${stderr}`));
    });
  });
  return stdout.trim();
}

async function waitForPath(path: string): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (existsSync(path)) return;
    await delay(5);
  }
  throw new Error("Child barrier timed out");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Child condition timed out");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (child.exitCode === null) await childOutput(child, true);
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model catalog interprocess request boundary", () => {
  it("allows one request across many concurrent processes", async () => {
    const server = await startCountedHttpServer(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate())],
      delayBetweenChunksMs: 20,
    }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-processes-");
    const processes = Array.from({ length: 12 }, (_value, index) =>
      runChild({
        cacheDirectory: tempDirectory(`catalog-process-cache-${index}-`),
        endpoint: server.url,
        installationRoot,
      }),
    );

    const outputs = await Promise.all(processes.map((child) => childOutput(child)));
    expect(server.requests, outputs.join("\n")).toHaveLength(1);
  });

  it("keeps a failed attempt claimed across process restarts", async () => {
    const server = await startCountedHttpServer((_request, index) =>
      index === 0
        ? { status: 500 }
        : {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate())],
          },
    );
    servers.push(server);
    const installationRoot = tempDirectory("catalog-restarts-");

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-cache-1-"),
        endpoint: server.url,
        installationRoot,
      }),
    );
    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-cache-2-"),
        endpoint: server.url,
        installationRoot,
        now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
      }),
    );

    expect(server.requests).toHaveLength(1);
  });

  it("refreshes when the interval elapses across ordinary process restarts", async () => {
    const server = await startCountedHttpServer((_request, index) =>
      index === 0
        ? { status: 500 }
        : {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate())],
          },
    );
    servers.push(server);
    const installationRoot = tempDirectory("catalog-restart-due-");

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-due-cache-1-"),
        elapsedNow: 0,
        endpoint: server.url,
        installationRoot,
      }),
    );
    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-due-cache-2-"),
        elapsedNow: MODEL_CATALOG_REFRESH_INTERVAL_MS,
        endpoint: server.url,
        installationRoot,
        now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS,
      }),
    );

    expect(server.requests).toHaveLength(2);
  });

  it("repairs an unfinished request before another process can refresh", async () => {
    const server = await startCountedHttpServer((_request, index) =>
      index === 0
        ? {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: ["{", JSON.stringify(candidate()).slice(1)],
            delayBetweenChunksMs: 2_000,
          }
        : {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate())],
          },
    );
    servers.push(server);
    const installationRoot = tempDirectory("catalog-uncertain-request-");
    const claimant = runChild({
      cacheDirectory: tempDirectory("catalog-uncertain-request-cache-1-"),
      elapsedNow: 0,
      endpoint: server.url,
      installationRoot,
    });
    await waitUntil(() => server.requests.length === 1);
    claimant.kill("SIGKILL");
    await childOutput(claimant, true);

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-uncertain-request-cache-2-"),
        elapsedNow: MODEL_CATALOG_REFRESH_INTERVAL_MS,
        endpoint: server.url,
        installationRoot,
        now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS,
      }),
    );
    expect(server.requests).toHaveLength(1);

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-uncertain-request-cache-3-"),
        elapsedNow: 2 * MODEL_CATALOG_REFRESH_INTERVAL_MS,
        endpoint: server.url,
        installationRoot,
        now: baseTime + 2 * MODEL_CATALOG_REFRESH_INTERVAL_MS,
      }),
    );
    expect(server.requests).toHaveLength(2);
  });

  it("keeps an attempt claimed when the wall clock jumps before process restart", async () => {
    const server = await startCountedHttpServer(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate())],
    }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-restart-clock-jump-");

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-clock-cache-1-"),
        endpoint: server.url,
        installationRoot,
      }),
    );
    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-restart-clock-cache-2-"),
        endpoint: server.url,
        installationRoot,
        now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS,
      }),
    );

    expect(server.requests).toHaveLength(1);
  });

  const restartFailures: readonly (
    | "malformed"
    | "server-error"
    | "timeout"
    | "too-many-requests"
  )[] = ["timeout", "too-many-requests", "server-error", "malformed"];

  it.each(restartFailures)(
    "keeps a %s attempt claimed across real process restarts",
    async (failure) => {
      const server = await startCountedHttpServer((_request, index) => {
        if (index > 0) {
          return {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate())],
          };
        }
        if (failure === "too-many-requests") return { status: 429 };
        if (failure === "server-error") return { status: 500 };
        if (failure === "malformed") {
          return { status: 200, headers: { ETag: '"malformed"' }, chunks: ["{broken"] };
        }
        return {
          status: 200,
          headers: { ETag: '"slow"' },
          chunks: ["{", JSON.stringify(candidate()).slice(1)],
          delayBetweenChunksMs: 2_000,
        };
      });
      servers.push(server);
      const installationRoot = tempDirectory(`catalog-${failure}-restart-`);
      await childOutput(
        runChild({
          cacheDirectory: tempDirectory(`catalog-${failure}-cache-1-`),
          endpoint: server.url,
          installationRoot,
        }),
      );
      await childOutput(
        runChild({
          cacheDirectory: tempDirectory(`catalog-${failure}-cache-2-`),
          endpoint: server.url,
          installationRoot,
          now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
        }),
      );
      expect(server.requests).toHaveLength(1);
    },
    10_000,
  );

  it("does not request after the claimant dies before network I/O", async () => {
    const server = await startCountedHttpServer(() => ({ status: 500 }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-death-");
    const readyPath = join(tempDirectory("catalog-barrier-"), "ready");
    const releasePath = join(tempDirectory("catalog-release-"), "release");
    const claimant = runChild({
      cacheDirectory: tempDirectory("catalog-death-cache-1-"),
      endpoint: server.url,
      installationRoot,
      mode: "pause-after-claim",
      readyPath,
      releasePath,
    });
    await waitForPath(readyPath);
    claimant.kill("SIGKILL");
    await childOutput(claimant, true);

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-death-cache-2-"),
        endpoint: server.url,
        installationRoot,
      }),
    );
    expect(server.requests).toHaveLength(0);
  });

  it("lets child-process readers discover the accepted revision before and after the owner exits", async () => {
    const server = await startCountedHttpServer(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate())],
    }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-owner-exit-");
    const readyPath = join(tempDirectory("catalog-owner-ready-"), "ready");
    const releasePath = join(tempDirectory("catalog-owner-release-"), "release");
    const owner = runChild({
      cacheDirectory: tempDirectory("catalog-writer-cache-"),
      endpoint: server.url,
      installationRoot,
      mode: "refresh-and-hold",
      readyPath,
      releasePath,
    });
    await waitForPath(readyPath);

    const liveOwnerRevision = await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-live-reader-cache-"),
        endpoint: server.url,
        installationRoot,
        mode: "read",
      }),
    );
    expect(liveOwnerRevision).toBe("2");
    expect(server.requests).toHaveLength(1);

    writeFileSync(releasePath, "release\n");
    await childOutput(owner);
    const exitedOwnerSelection: unknown = JSON.parse(
      await childOutput(
        runChild({
          cacheDirectory: tempDirectory("catalog-exited-reader-cache-"),
          endpoint: server.url,
          installationRoot,
          mode: "select",
        }),
      ),
    );
    expect(exitedOwnerSelection).toMatchObject({
      revision: 2,
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          models: expect.arrayContaining(["claude-sonnet-5"]),
        }),
      ]),
    });
    expect(server.requests).toHaveLength(1);
  });

  it("keeps picker reads and a restart inside the claimed daily request", async () => {
    const server = await startCountedHttpServer(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate())],
    }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-picker-restart-");

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-picker-startup-cache-"),
        endpoint: server.url,
        installationRoot,
      }),
    );

    const selection: unknown = JSON.parse(
      await childOutput(
        runChild({
          cacheDirectory: tempDirectory("catalog-picker-cache-"),
          endpoint: server.url,
          installationRoot,
          mode: "select",
        }),
      ),
    );
    expect(selection).toMatchObject({ revision: 2 });

    await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-picker-restart-cache-"),
        endpoint: server.url,
        installationRoot,
        now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
      }),
    );

    expect(server.requests).toHaveLength(1);
  });
});

describe("model catalog HTTPS process boundary", () => {
  let certificateDirectory: string | undefined;
  let certificates: HttpsTestCertificates;

  beforeAll(() => {
    certificateDirectory = mkdtempSync(join(tmpdir(), "catalog-https-certificates-"));
    certificates = createHttpsTestCertificates(certificateDirectory);
  }, 20_000);

  afterAll(() => {
    if (certificateDirectory !== undefined) {
      rmSync(certificateDirectory, { recursive: true, force: true });
    }
  });

  interface TlsRejectionCase {
    readonly certificate: "valid" | "wrongHostname";
    readonly title: string;
    readonly trustTestCa: boolean;
  }

  const rejectionCases: readonly TlsRejectionCase[] = [
    { certificate: "valid", title: "an untrusted certificate chain", trustTestCa: false },
    {
      certificate: "wrongHostname",
      title: "a trusted certificate for the wrong hostname",
      trustTestCa: true,
    },
  ];

  it.each(rejectionCases)(
    "rejects $title and consumes the attempt window across a replacement process",
    async ({ certificate, trustTestCa }) => {
      const rejectedServer = await startCountedHttpsServer(certificates[certificate], () => ({
        status: 200,
        headers: { ETag: '"revision-2"' },
        chunks: [JSON.stringify(candidate())],
      }));
      servers.push(rejectedServer);
      const installationRoot = tempDirectory(`catalog-${certificate}-installation-`);

      const rejectedOutput = await childOutput(
        runChild({
          cacheDirectory: tempDirectory(`catalog-${certificate}-cache-1-`),
          elapsedNow: 0,
          endpoint: rejectedServer.url,
          extraCaCertificatePath: trustTestCa ? certificates.trustedCaPath : undefined,
          installationRoot,
        }),
      );
      expect(rejectedOutput).toBe(
        '{"lifecycle":{"kind":"owner"},"outcome":{"kind":"retained","reason":"request-failed","revision":1}}',
      );
      expect(rejectedServer.requests).toHaveLength(0);

      const validServer = await startCountedHttpsServer(certificates.valid, () => ({
        status: 200,
        headers: { ETag: '"revision-2"' },
        chunks: [JSON.stringify(candidate())],
      }));
      servers.push(validServer);
      const replacementOutput = await childOutput(
        runChild({
          cacheDirectory: tempDirectory(`catalog-${certificate}-cache-2-`),
          elapsedNow: MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
          endpoint: validServer.url,
          extraCaCertificatePath: certificates.trustedCaPath,
          installationRoot,
          now: baseTime + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
        }),
      );
      expect(replacementOutput).toBe(
        '{"lifecycle":{"kind":"owner"},"outcome":{"kind":"retained","reason":"not-due","revision":1}}',
      );
      expect(validServer.requests).toHaveLength(0);
    },
    20_000,
  );

  it("accepts a trusted certificate for the endpoint hostname and loads the intended revision", async () => {
    const server = await startCountedHttpsServer(certificates.valid, () => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate())],
    }));
    servers.push(server);
    const installationRoot = tempDirectory("catalog-valid-tls-installation-");

    const refreshOutput = await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-valid-tls-cache-1-"),
        elapsedNow: 0,
        endpoint: server.url,
        extraCaCertificatePath: certificates.trustedCaPath,
        installationRoot,
      }),
    );
    expect(refreshOutput).toBe(
      '{"lifecycle":{"kind":"owner"},"outcome":{"kind":"updated","revision":2}}',
    );
    expect(server.requests).toHaveLength(1);

    const loadedRevision = await childOutput(
      runChild({
        cacheDirectory: tempDirectory("catalog-valid-tls-cache-2-"),
        endpoint: server.url,
        extraCaCertificatePath: certificates.trustedCaPath,
        installationRoot,
        mode: "read",
      }),
    );
    expect(loadedRevision).toBe("2");
    expect(server.requests).toHaveLength(1);
  }, 20_000);
});
