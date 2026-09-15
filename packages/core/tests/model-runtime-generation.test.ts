import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalogSnapshot } from "@enduragent/coach-contract/model-catalog";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { engineConfigFromConfig } from "../src/agent/engine-host-adapter.js";
import { acceptModelCatalogSnapshot } from "../src/model-catalog.js";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import {
  persistResolvedModelProfiles,
  SELECTED_MODEL_PROFILES_FILE,
} from "../src/model-runtime-generation.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "model-runtime-generation-"));
  directories.push(directory);
  return directory;
}

function config(dataDir: string, model = "gpt-5.6-sol"): Config {
  return {
    dataSource: "platform",
    llm: {
      provider: "openai",
      model,
      compactModel: "gpt-5.6-luna",
      flushModel: "gpt-5.6-terra",
      apiKey: "synthetic",
    },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1_050_000,
    dataDir,
  };
}

function accepted(snapshot: ModelCatalogSnapshot) {
  const record = acceptModelCatalogSnapshot(snapshot);
  if (record === undefined) throw new Error("Synthetic catalog was not accepted");
  return record;
}

function revision(revisionNumber: number): ModelCatalogSnapshot {
  const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
  snapshot.revision = revisionNumber;
  snapshot.provenance = { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" };
  return snapshot;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model runtime generation", () => {
  it("captures chat, compact, and flush profiles from one revision", () => {
    const dataDir = temporaryDirectory();
    const catalog = accepted(revision(7));

    const projected = engineConfigFromConfig(config(dataDir), {
      catalog,
      profileStorageDirectory: join(dataDir, "profiles"),
    });

    expect(projected.models.catalogRevision).toBe(7);
    expect(projected.models.chat).toMatchObject({
      kind: "catalog",
      catalogRevision: 7,
      provider: "openai",
      model: "gpt-5.6-sol",
      contextWindowTokens: 1_050_000,
      imageInput: "supported",
      pricing: { kind: "token-rates", inputUsdPerMillion: 5 },
    });
    expect(projected.models.compact).toMatchObject({
      kind: "catalog",
      catalogRevision: 7,
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(projected.models.flush).toMatchObject({
      kind: "catalog",
      catalogRevision: 7,
      provider: "openai",
      model: "gpt-5.6-terra",
    });
    expect(
      new Set([
        projected.models.chat.catalogRevision,
        projected.models.compact.catalogRevision,
        projected.models.flush.catalogRevision,
      ]),
    ).toEqual(new Set([7]));
    expect(Object.isFrozen(projected.models)).toBe(true);
    expect(Object.isFrozen(projected.models.chat)).toBe(true);
    expect(Object.isFrozen(projected.models.chat.pricing)).toBe(true);
    expect(existsSync(join(dataDir, "profiles", SELECTED_MODEL_PROFILES_FILE))).toBe(false);
  });

  it("keeps retired primary and background metadata across restart", () => {
    const dataDir = temporaryDirectory();
    const profileStorageDirectory = join(dataDir, "profiles");
    const available = revision(8);
    const openai = available.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("OpenAI provider is missing");
    openai.models.push({
      modelId: "retired-primary",
      label: "Retired Primary",
      order: 20,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "known", tokens: 345_678 },
      imageInput: "incompatible",
      pricing: {
        kind: "token-rates",
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 4,
        cacheReadUsdPerMillion: 0.2,
        cacheWriteUsdPerMillion: 0,
      },
    });
    openai.models.push({
      modelId: "retired-background",
      label: "Retired Background",
      order: 21,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "known", tokens: 234_567 },
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
    const selected = config(dataDir, "retired-primary");
    selected.llm.compactModel = "retired-background";
    selected.llm.flushModel = "retired-background";

    persistResolvedModelProfiles(
      profileStorageDirectory,
      engineConfigFromConfig(selected, {
        catalog: accepted(available),
        profileStorageDirectory,
      }).models,
    );

    const retired = revision(9);
    const retiredCatalog = accepted(retired);
    const restarted = engineConfigFromConfig(selected, {
      catalog: retiredCatalog,
      profileStorageDirectory,
    });
    const retiredProvider = retiredCatalog.effective.providers.find(
      (provider) => provider.provider === "openai",
    );
    const suggested =
      retiredProvider?.kind === "suggested"
        ? retiredProvider.models.map((model) => model.modelId)
        : [];

    expect(suggested).not.toContain("retired-primary");
    expect(suggested).not.toContain("retired-background");
    expect(restarted.models.chat).toMatchObject({
      kind: "catalog",
      catalogRevision: 9,
      provider: "openai",
      model: "retired-primary",
      contextWindowTokens: 345_678,
      imageInput: "incompatible",
      pricing: { kind: "token-rates", inputUsdPerMillion: 2 },
    });
    expect(restarted.models.compact).toMatchObject({
      kind: "catalog",
      catalogRevision: 9,
      model: "retired-background",
      contextWindowTokens: 234_567,
      pricing: { kind: "unknown" },
    });
    expect(restarted.models.flush).toEqual(restarted.models.compact);
  });

  it("does not reuse persisted metadata for a present but incompatible entry", () => {
    const dataDir = temporaryDirectory();
    const profileStorageDirectory = join(dataDir, "profiles");
    const selected = config(dataDir);

    persistResolvedModelProfiles(
      profileStorageDirectory,
      engineConfigFromConfig(selected, {
        catalog: accepted(revision(14)),
        profileStorageDirectory,
      }).models,
    );

    const incompatible = revision(15);
    const openai = incompatible.providers.find((provider) => provider.providerId === "openai");
    const model = openai?.models.find((entry) => entry.modelId === "gpt-5.6-sol");
    if (model === undefined) throw new Error("OpenAI default model is missing");
    model.compatibilityProfile = "openai-ai-sdk-v2";

    const projected = engineConfigFromConfig(selected, {
      catalog: accepted(incompatible),
      profileStorageDirectory,
    });

    expect(projected.models.chat).toEqual({
      kind: "custom",
      catalogRevision: 15,
      provider: "openai",
      model: "gpt-5.6-sol",
      contextWindowTokens: 200_000,
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
  });

  it("uses conservative custom metadata and preserves a local context override", () => {
    const dataDir = temporaryDirectory();
    const selected = config(dataDir, "private/custom-model");
    selected.contextWindowTokens = 42_000;
    selected.contextWindowTokensOverride = 42_000;
    selected.llm.compactModel = "private/custom-model";
    selected.llm.flushModel = "private/custom-model";

    const projected = engineConfigFromConfig(selected, {
      catalog: accepted(revision(10)),
      profileStorageDirectory: join(dataDir, "profiles"),
    });

    expect(projected.models.chat).toEqual({
      kind: "custom",
      catalogRevision: 10,
      provider: "openai",
      model: "private/custom-model",
      contextWindowTokens: 42_000,
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
    expect(projected.models.compact).toEqual(projected.models.chat);
    expect(projected.models.flush).toEqual(projected.models.chat);
  });

  it("never reuses metadata across providers with the same model id", () => {
    const dataDir = temporaryDirectory();
    const profileStorageDirectory = join(dataDir, "profiles");
    const first = revision(11);
    const openai = first.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("OpenAI provider is missing");
    openai.models.push({
      modelId: "shared-id",
      label: "OpenAI Shared",
      order: 20,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "known", tokens: 333_333 },
      imageInput: "supported",
      pricing: { kind: "unknown" },
    });
    const openaiConfig = config(dataDir, "shared-id");
    openaiConfig.llm.compactModel = "shared-id";
    openaiConfig.llm.flushModel = "shared-id";
    persistResolvedModelProfiles(
      profileStorageDirectory,
      engineConfigFromConfig(openaiConfig, {
        catalog: accepted(first),
        profileStorageDirectory,
      }).models,
    );

    const second = revision(12);
    const googleConfig = config(dataDir, "shared-id");
    googleConfig.llm.provider = "google";
    googleConfig.llm.compactModel = "shared-id";
    googleConfig.llm.flushModel = "shared-id";
    const projected = engineConfigFromConfig(googleConfig, {
      catalog: accepted(second),
      profileStorageDirectory,
    });

    expect(projected.models.chat).toEqual({
      kind: "custom",
      catalogRevision: 12,
      provider: "google",
      model: "shared-id",
      contextWindowTokens: 200_000,
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
  });

  it("resolves runtime-only provider metadata without exposing provider suggestions", () => {
    const dataDir = temporaryDirectory();
    const catalog = accepted(revision(13));
    const selected = config(dataDir, "gpt-5.6-sol");
    selected.llm.provider = "codex-agent";
    selected.llm.codexAgent = { enabled: true };

    const projected = engineConfigFromConfig(selected, {
      catalog,
      profileStorageDirectory: join(dataDir, "profiles"),
    });

    expect(catalog.effective.providers.some(({ provider }) => provider === "codex-agent")).toBe(
      false,
    );
    expect(projected.models.chat).toMatchObject({
      kind: "catalog",
      provider: "codex-agent",
      model: "gpt-5.6-sol",
      catalogRevision: 13,
      contextWindowTokens: 1_050_000,
      pricing: { kind: "token-rates", inputUsdPerMillion: 5 },
    });
  });
});
