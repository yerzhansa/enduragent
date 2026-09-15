import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  bundledAcceptedCatalog,
  engineConfigFromConfig,
  loadConfigFromYaml,
  type Config,
  type LoadConfigOptions,
} from "@enduragent/core";
import type { EngineConfig } from "@enduragent/engine";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { parse as parseYaml } from "yaml";

export type ReadinessFailureStatus = "not-configured" | "unreadable" | "malformed";

export type ReadinessFailure =
  | { readonly status: "not-configured"; readonly configPath: string }
  | { readonly status: "unreadable" }
  | { readonly status: "malformed" };

export type ReadinessResult =
  | {
      readonly status: "ready";
      readonly config: Config;
      readonly engineConfig: EngineConfig;
    }
  | ReadinessFailure;

export interface ReadinessDependencies {
  readonly readConfigFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly resolvePhysicalPath?: (path: string) => Promise<string>;
  readonly loadConfig: (
    yaml: Record<string, unknown>,
    configDir: string,
    options: LoadConfigOptions,
  ) => Config;
  readonly projectConfig: (config: Config) => EngineConfig;
}

const readinessDependencies: ReadinessDependencies = {
  readConfigFile: readFile,
  resolvePhysicalPath: realpath,
  loadConfig: loadConfigFromYaml,
  projectConfig: (config) => engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }),
};

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function parseConfig(source: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseYaml(source) as unknown;
    return isMap(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function checkHomeReadiness(
  home: AthleteHome,
  overrides: Partial<ReadinessDependencies> = {},
): Promise<ReadinessResult> {
  const dependencies = { ...readinessDependencies, ...overrides };
  const configPath = join(home.configDir, "config.yaml");
  let initialSource: string;
  try {
    initialSource = await dependencies.readConfigFile(configPath, "utf8");
  } catch (error) {
    return isMissing(error) ? { status: "not-configured", configPath } : { status: "unreadable" };
  }
  if (parseConfig(initialSource) === undefined) return { status: "malformed" };

  let source: string;
  try {
    source = await dependencies.readConfigFile(configPath, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  const yaml = parseConfig(source);
  if (yaml === undefined) return { status: "malformed" };
  try {
    const config = dependencies.loadConfig(yaml, home.configDir, {
      defaultDataDir: home.root,
    });
    const resolvePhysicalPath = dependencies.resolvePhysicalPath ?? realpath;
    const [configuredDataDir, selectedHome] = await Promise.all([
      resolvePhysicalPath(config.dataDir),
      resolvePhysicalPath(home.root),
    ]);
    if (configuredDataDir !== selectedHome) return { status: "malformed" };
    const engineConfig = dependencies.projectConfig(config);
    return { status: "ready", config, engineConfig };
  } catch {
    return { status: "malformed" };
  }
}
