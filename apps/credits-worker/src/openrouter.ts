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

export class OpenRouterManagementClient implements OpenRouterKeys {
  constructor(
    private readonly managementKey: string,
    private readonly config: OpenRouterConfig,
  ) {}
  create(_input: {
    name: string;
    limitUsdMillis: UsdMillis;
    guardrailMode: GuardrailMode;
    guardrailId: string | undefined;
  }): Promise<{ key: AthleteKey; hash: KeyHash }> {
    throw new Error("not implemented");
  }
  get(_hash: KeyHash): Promise<OpenRouterKeyView> {
    throw new Error("not implemented");
  }
  setLimit(_hash: KeyHash, _limitUsdMillis: UsdMillis): Promise<void> {
    throw new Error("not implemented");
  }
  setDisabled(_hash: KeyHash, _disabled: boolean): Promise<void> {
    throw new Error("not implemented");
  }
  delete(_hash: KeyHash): Promise<void> {
    throw new Error("not implemented");
  }
  count(): Promise<number> {
    throw new Error("not implemented");
  }
  list(): Promise<readonly OpenRouterKeyView[]> {
    throw new Error("not implemented");
  }
}
