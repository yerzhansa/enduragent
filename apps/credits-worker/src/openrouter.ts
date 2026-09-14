import { DomainError, asUsdMillis } from "./domain.js";
import type { AthleteKey, KeyHash, UsdMillis } from "./domain.js";

export type GuardrailMode = "at_create" | "after_create" | "off";

export type OpenRouterKeyView = {
  hash: KeyHash;
  limitUsdMillis: UsdMillis;
  remainingUsdMillis: UsdMillis;
  usageUsdMillis: UsdMillis;
  disabled: boolean;
};

export type OpenRouterKeys = {
  create(input: {
    name: string;
    limitUsdMillis: UsdMillis;
    guardrailMode: GuardrailMode;
    guardrailId: string | undefined;
  }): Promise<{ key: AthleteKey; hash: KeyHash }>;

  get(hash: KeyHash): Promise<OpenRouterKeyView>;

  setLimit(hash: KeyHash, limitUsdMillis: UsdMillis): Promise<void>;

  setDisabled(hash: KeyHash, disabled: boolean): Promise<void>;

  delete(hash: KeyHash): Promise<void>;

  count(): Promise<number>;

  list(): Promise<readonly OpenRouterKeyView[]>;
};

export type OpenRouterConfig = {
  guardrailMode: GuardrailMode;
  guardrailId: string | undefined;
  keyCountCeiling: number | undefined;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("unavailable");
  return value as Record<string, unknown>;
}

function usd(value: unknown): UsdMillis {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new DomainError("unavailable");
  const millis = Math.round(value * 1000);
  if (!Number.isSafeInteger(millis)) throw new DomainError("unavailable");
  return asUsdMillis(millis);
}

function keyView(value: unknown): OpenRouterKeyView {
  const data = record(value);
  if (typeof data.hash !== "string" || !data.hash || typeof data.disabled !== "boolean")
    throw new DomainError("unavailable");
  return {
    hash: data.hash as KeyHash,
    limitUsdMillis: usd(data.limit),
    remainingUsdMillis: usd(data.limit_remaining),
    usageUsdMillis: usd(data.usage),
    disabled: data.disabled,
  };
}

export class OpenRouterManagementClient implements OpenRouterKeys {
  constructor(
    private readonly managementKey: string,
    config: OpenRouterConfig,
  ) {
    if (config.keyCountCeiling !== undefined) throw new DomainError("unavailable");
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    try {
      if (!this.managementKey) throw new DomainError("unavailable");
      const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.managementKey}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      if (!response.ok) throw new DomainError("unavailable");
      return response.status === 204 ? undefined : await response.json();
    } catch {
      throw new DomainError("unavailable");
    }
  }

  async create(
    input: Parameters<OpenRouterKeys["create"]>[0],
  ): Promise<{ key: AthleteKey; hash: KeyHash }> {
    if (input.guardrailMode !== "off" && !input.guardrailId) throw new DomainError("unavailable");
    const result = record(
      await this.request("/keys", "POST", {
        name: input.name,
        limit: input.limitUsdMillis / 1000,
        ...(input.guardrailMode === "at_create" ? { guardrail_id: input.guardrailId } : {}),
      }),
    );
    const data = record(result.data);
    if (typeof data.hash !== "string" || !data.hash) throw new DomainError("unavailable");
    const hash = data.hash as KeyHash;
    try {
      if (typeof result.key !== "string" || !result.key) throw new DomainError("unavailable");
      if (input.guardrailMode === "after_create") {
        const assignment = record(
          await this.request(
            `/guardrails/${encodeURIComponent(input.guardrailId ?? "")}/assignments/keys`,
            "POST",
            { key_hashes: [hash] },
          ),
        );
        if (assignment.assigned_count !== 1) throw new DomainError("unavailable");
      }
      if (input.guardrailMode === "at_create") {
        let offset = 0;
        const seen = new Set<string>();
        for (;;) {
          const assigned = record(
            await this.request(
              `/guardrails/${encodeURIComponent(input.guardrailId ?? "")}/assignments/keys?offset=${offset}`,
              "GET",
            ),
          ).data;
          if (!Array.isArray(assigned) || assigned.length === 0)
            throw new DomainError("unavailable");
          if (assigned.some((row) => record(row).key_hash === hash)) break;
          for (const row of assigned) {
            const keyHash = record(row).key_hash;
            if (typeof keyHash !== "string" || seen.has(keyHash))
              throw new DomainError("unavailable");
            seen.add(keyHash);
          }
          offset += assigned.length;
        }
      }
      return { key: result.key as AthleteKey, hash };
    } catch {
      await this.setDisabled(hash, true).catch(() => undefined);
      await this.delete(hash).catch(() => undefined);
      throw new DomainError("unavailable");
    }
  }

  async get(hash: KeyHash): Promise<OpenRouterKeyView> {
    return keyView(record(await this.request(`/keys/${encodeURIComponent(hash)}`, "GET")).data);
  }
  async setLimit(hash: KeyHash, limitUsdMillis: UsdMillis): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(hash)}`, "PATCH", {
      limit: limitUsdMillis / 1000,
    });
  }
  async setDisabled(hash: KeyHash, disabled: boolean): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(hash)}`, "PATCH", { disabled });
  }
  async delete(hash: KeyHash): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(hash)}`, "DELETE");
  }
  async count(): Promise<number> {
    return (await this.list()).length;
  }
  async list(): Promise<readonly OpenRouterKeyView[]> {
    const rows: OpenRouterKeyView[] = [];
    const seen = new Set<string>();
    for (;;) {
      const page = record(
        await this.request(`/keys?include_disabled=true&offset=${rows.length}`, "GET"),
      ).data;
      if (!Array.isArray(page)) throw new DomainError("unavailable");
      if (page.length === 0) return rows;
      for (const raw of page) {
        const row = keyView(raw);
        if (seen.has(row.hash)) throw new DomainError("unavailable");
        seen.add(row.hash);
        rows.push(row);
      }
    }
  }
}
