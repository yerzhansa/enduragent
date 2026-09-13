import { writeFile } from "node:fs/promises";
import { sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { athleteIdFromUuid } from "../src/domain.js";

type Inputs = Record<string, string | undefined>;
type Transport = typeof fetch;
const invalid = () => new Error("invalid proof configuration");
const failed = () => new Error("proof request failed");
const sensitive =
  /signed|device.?token|devicecheck|authorization|bearer|private|password|secret|p8|jwt|access.?token|refresh.?token/i;

export function redactProof(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let text = value
      .replace(/Bearer\s+[^\s"']+/gi, "REDACTED")
      .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-REDACTED")
      .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "REDACTED")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "REDACTED");
    for (const secret of secrets) if (secret) text = text.split(secret).join("REDACTED");
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redactProof(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitive.test(key))
        .map(([key, item]) => [
          key,
          /^(?:key|apiKey|api_key)$/.test(key) && typeof item === "string"
            ? "sk-or-REDACTED"
            : redactProof(item, secrets),
        ]),
    );
  return value;
}

export function proofOrigin(raw: string | undefined): string {
  if (!raw) throw invalid();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port
  )
    throw invalid();
  return url.origin;
}

function required(input: Inputs, name: string): string {
  const value = input[name];
  if (!value) throw invalid();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
  return value as Record<string, unknown>;
}

function select(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((row) => select(row, fields));
  const row = object(value);
  return Object.fromEntries(
    fields.filter((field) => field in row).map((field) => [field, row[field]]),
  );
}

type HistoryVerifier = {
  verifyAndDecodeTransaction(signed: string): Promise<{ originalTransactionId?: string }>;
};

export async function runProof(
  input: Inputs,
  transport: Transport = fetch,
  verifier?: HistoryVerifier,
): Promise<unknown> {
  const origin = proofOrigin(input.WORKER_ORIGIN);
  if (input.APPLE_ENVIRONMENT !== "sandbox" || input.KEY_COUNT_CEILING !== undefined)
    throw invalid();
  const mode = input.PROOF_MODE ?? "validate";
  const secrets = Object.entries(input)
    .filter(([name]) => sensitive.test(name) || /(?:_P8|_TOKEN|MANAGEMENT_KEY)$/.test(name))
    .flatMap(([, value]) => (value ? [value] : []));
  const request = async (
    url: string,
    method = "GET",
    body?: unknown,
    credential?: string,
    acceptedStatuses?: readonly number[],
  ): Promise<unknown> => {
    const destination = new URL(url).origin;
    if (
      ![
        origin,
        "https://openrouter.ai",
        "https://api.storekit-sandbox.apple.com",
        "https://api.development.devicecheck.apple.com",
      ].includes(destination)
    )
      throw invalid();
    try {
      const response = await transport(url, {
        method,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (
        (acceptedStatuses ? !acceptedStatuses.includes(response.status) : !response.ok) ||
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw failed();
      if (response.status === 404 && acceptedStatuses?.includes(404)) return { httpStatus: 404 };
      if (response.status === 204) return {};
      return await response.json();
    } catch {
      throw failed();
    }
  };
  const athlete = () => athleteIdFromUuid(required(input, "ATHLETE_ID"));
  const grant = () =>
    request(`${origin}/grant`, "POST", {
      athleteId: athlete(),
      deviceCheckToken: required(input, "DEVICECHECK_TOKEN"),
    });
  const spendFields = [
    "athleteId",
    "keyHash",
    "orphanedRemoteKey",
    "missingRemoteKey",
    "grantedUsdMillis",
    "refundedUsdMillis",
    "remainingUsdMillis",
    "usageUsdMillis",
    "creditsRemaining",
    "disabled",
  ];
  let result: unknown;
  switch (mode) {
    case "validate":
      result = { mode, origin, environment: "sandbox" };
      break;
    case "health":
      result = select(await request(`${origin}/health`), ["ok"]);
      break;
    case "spend":
      result = select(
        await request(
          `${origin}/ops/spend${input.ATHLETE_ID ? `?athleteId=${athlete()}` : ""}`,
          "GET",
          undefined,
          required(input, "OPERATOR_TOKEN"),
        ),
        spendFields,
      );
      break;
    case "key": {
      const reply = object(
        await request(
          `https://openrouter.ai/api/v1/keys/${encodeURIComponent(required(input, "KEY_HASH"))}`,
          "GET",
          undefined,
          required(input, "OPENROUTER_MANAGEMENT_KEY"),
        ),
      );
      result = select(reply.data, ["hash", "limit", "limit_remaining", "usage", "disabled"]);
      break;
    }
    case "inventory": {
      const keys: unknown[] = [];
      const hashes = new Set<string>();
      for (;;) {
        const page = object(
          await request(
            `https://openrouter.ai/api/v1/keys?include_disabled=true&offset=${keys.length}`,
            "GET",
            undefined,
            required(input, "OPENROUTER_MANAGEMENT_KEY"),
          ),
        ).data;
        if (!Array.isArray(page)) throw failed();
        if (page.length === 0) break;
        for (const value of page) {
          const row = object(value);
          if (typeof row.hash !== "string" || hashes.has(row.hash)) throw failed();
          hashes.add(row.hash);
          keys.push(select(row, ["hash", "limit", "limit_remaining", "usage", "disabled"]));
        }
      }
      result = { observedKeyCount: keys.length, keys };
      break;
    }
    case "grant":
      result = select(await grant(), ["kind", "credits", "added", "key"]);
      break;
    case "ban-bit": {
      if (required(input, "DISPOSABLE_ATHLETE_CONFIRMED") !== athlete()) throw invalid();
      const deviceToken = required(input, "DEVICECHECK_TOKEN");
      const deviceKey = required(input, "APPLE_DEVICECHECK_P8");
      const team = required(input, "APPLE_DEVICECHECK_TEAM_ID");
      const keyId = required(input, "APPLE_DEVICECHECK_KEY_ID");
      const queryBits = async () => {
        const timestamp = Math.floor(performance.timeOrigin + performance.now());
        const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
          "base64url",
        );
        const body = Buffer.from(
          JSON.stringify({ iss: team, iat: Math.floor(timestamp / 1000) }),
        ).toString("base64url");
        const signingInput = `${head}.${body}`;
        let credential: string;
        try {
          credential = `${signingInput}.${sign("sha256", Buffer.from(signingInput), { key: deviceKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
        } catch {
          throw invalid();
        }
        const bits = object(
          await request(
            "https://api.development.devicecheck.apple.com/v1/query_two_bits",
            "POST",
            { device_token: deviceToken, transaction_id: crypto.randomUUID(), timestamp },
            credential,
          ),
        );
        if (typeof bits.bit0 !== "boolean" || typeof bits.bit1 !== "boolean") throw failed();
        return { bit0: bits.bit0, bit1: bits.bit1 };
      };
      const before = await queryBits();
      await request(
        `${origin}/ops/ban`,
        "POST",
        { athleteId: athlete() },
        required(input, "OPERATOR_TOKEN"),
      );
      try {
        const refusal = object(
          await request(
            `${origin}/grant`,
            "POST",
            { athleteId: athlete(), deviceCheckToken: deviceToken },
            undefined,
            [403],
          ),
        );
        if (refusal.error !== "banned") throw failed();
        const after = await queryBits();
        const spend = object(
          await request(
            `${origin}/ops/spend?athleteId=${athlete()}`,
            "GET",
            undefined,
            required(input, "OPERATOR_TOKEN"),
          ),
        );
        result = {
          banRequested: true,
          grantRefused: true,
          before,
          after,
          keyDisabled: spend.disabled === true,
          verified: after.bit1 && after.bit0 === before.bit0 && spend.disabled === true,
        };
      } catch {
        result = {
          banRequested: true,
          verified: false,
          error: "proof request failed; inspect device and provider state",
        };
      }
      break;
    }
    case "probe-key": {
      const credential = required(input, "OPENROUTER_MANAGEMENT_KEY");
      const guardrail = required(input, "OPENROUTER_GUARDRAIL_ID");
      const guardrailMode = input.PROBE_GUARDRAIL_MODE ?? "after_create";
      if (guardrailMode !== "after_create" && guardrailMode !== "at_create") throw invalid();
      const created = object(
        await request(
          "https://openrouter.ai/api/v1/keys",
          "POST",
          {
            name: "enduragent-testflight-proof",
            limit: 0,
            ...(guardrailMode === "at_create" ? { guardrail_id: guardrail } : {}),
          },
          credential,
        ),
      );
      const data = object(created.data);
      if (typeof data.hash !== "string" || !data.hash) throw failed();
      const hash = data.hash;
      let proof: unknown = { hash, assignmentVerified: false };
      let cleaned = false;
      try {
        if (guardrailMode === "after_create") {
          const assigned = object(
            await request(
              `https://openrouter.ai/api/v1/guardrails/${encodeURIComponent(guardrail)}/assignments/keys`,
              "POST",
              { key_hashes: [hash] },
              credential,
            ),
          );
          if (assigned.assigned_count !== 1) throw failed();
        }
        let offset = 0;
        const assignedHashes = new Set<string>();
        for (;;) {
          const page = object(
            await request(
              `https://openrouter.ai/api/v1/guardrails/${encodeURIComponent(guardrail)}/assignments/keys?offset=${offset}`,
              "GET",
              undefined,
              credential,
            ),
          ).data;
          if (!Array.isArray(page) || page.length === 0) throw failed();
          if (page.some((row) => object(row).key_hash === hash)) break;
          for (const row of page) {
            const keyHash = object(row).key_hash;
            if (typeof keyHash !== "string" || assignedHashes.has(keyHash)) throw failed();
            assignedHashes.add(keyHash);
          }
          offset += page.length;
        }
        const view = object(
          await request(
            `https://openrouter.ai/api/v1/keys/${encodeURIComponent(hash)}`,
            "GET",
            undefined,
            credential,
          ),
        );
        proof = {
          hash,
          assignmentVerified: true,
          key: select(view.data, ["hash", "limit", "limit_remaining", "usage", "disabled"]),
        };
      } catch {
        proof = { hash, assignmentVerified: false, error: "proof request failed" };
      }
      try {
        await request(
          `https://openrouter.ai/api/v1/keys/${encodeURIComponent(hash)}`,
          "PATCH",
          { disabled: true },
          credential,
        );
      } catch {}
      try {
        await request(
          `https://openrouter.ai/api/v1/keys/${encodeURIComponent(hash)}`,
          "DELETE",
          undefined,
          credential,
        );
        cleaned = true;
      } catch {}
      result = { proof, cleaned };
      break;
    }
    case "apple-test":
    case "history": {
      const issued = Math.floor((performance.timeOrigin + performance.now()) / 1000);
      const header = Buffer.from(
        JSON.stringify({
          alg: "ES256",
          kid: required(input, "APPLE_APP_STORE_KEY_ID"),
          typ: "JWT",
        }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: required(input, "APPLE_APP_STORE_ISSUER_ID"),
          iat: issued,
          exp: issued + 300,
          aud: "appstoreconnect-v1",
          bid: "icu.enduragent.app",
        }),
      ).toString("base64url");
      const data = `${header}.${payload}`;
      let credential: string;
      try {
        credential = `${data}.${sign("sha256", Buffer.from(data), { key: required(input, "APPLE_APP_STORE_P8"), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      } catch {
        throw invalid();
      }
      if (mode === "apple-test") {
        const reply = object(
          await request(
            "https://api.storekit-sandbox.apple.com/inApps/v1/notifications/test",
            "POST",
            undefined,
            credential,
          ),
        );
        result = {
          requested: typeof reply.testNotificationToken === "string",
          deliveryVerified: false,
        };
      } else {
        const endpoint = `https://api.storekit-sandbox.apple.com/inApps/v2/history/${encodeURIComponent(required(input, "ORIGINAL_TRANSACTION_ID"))}`;
        const revisions = new Set<string>();
        const originals = new Set<string>();
        let transactionCount = 0;
        let revision: string | undefined;
        do {
          const page = object(
            await request(
              revision ? `${endpoint}?revision=${encodeURIComponent(revision)}` : endpoint,
              "GET",
              undefined,
              credential,
              [200, 404],
            ),
          );
          if (page.httpStatus === 404) {
            if (revision) throw failed();
            result = { historyHttpStatus: 404, verified: false };
            break;
          }
          if (!verifier) {
            result = {
              historyHttpStatus: 200,
              verified: false,
              error: "strict verification transport unavailable",
            };
            break;
          }
          if (!Array.isArray(page.signedTransactions) || typeof page.hasMore !== "boolean")
            throw failed();
          for (const signed of page.signedTransactions) {
            if (typeof signed !== "string") throw failed();
            const transaction = await verifier.verifyAndDecodeTransaction(signed);
            if (!transaction.originalTransactionId) throw failed();
            originals.add(transaction.originalTransactionId);
            transactionCount += 1;
          }
          revision = undefined;
          if (page.hasMore) {
            if (typeof page.revision !== "string" || !page.revision || revisions.has(page.revision))
              throw failed();
            revision = page.revision;
            revisions.add(revision);
          }
          result = {
            historyHttpStatus: 200,
            verified: transactionCount > 0,
            transactionCount,
            originalTransactionCount: originals.size,
          };
        } while (revision);
      }
      break;
    }
    default:
      throw invalid();
  }
  return redactProof(result, secrets);
}

export async function writeProof(run: () => Promise<unknown>) {
  try {
    const result = await run();
    const text = JSON.stringify(redactProof(result), null, 2) + "\n";
    if (process.env.PROOF_OUTPUT) await writeFile(process.env.PROOF_OUTPUT, text, { mode: 0o600 });
    process.stdout.write(text);
  } catch {
    process.stderr.write(
      JSON.stringify({
        error: "proof failed; inspect configuration and provider state before retrying any mint",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
