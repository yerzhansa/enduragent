import { arch, platform, release } from "node:os";

export interface ApplicationCaptureEnvironment {
  readonly platform: string;
  readonly architecture: string;
  readonly darwinRelease: string;
}

export function currentApplicationEnvironment(): ApplicationCaptureEnvironment {
  return { platform: platform(), architecture: arch(), darwinRelease: release() };
}

export function applicationBaselineForEnvironment(
  environment: ApplicationCaptureEnvironment,
): string {
  const version = /^(\d+)\.(\d+)\.\d+$/u.exec(environment.darwinRelease);
  if (environment.platform === "darwin" && environment.architecture === "arm64") {
    if (version?.[1] === "25" && version[2] === "2") return "application-ui-extraction-v1";
    if (version?.[1] === "25" && version[2] === "5") {
      return "application-ui-extraction-darwin-25-5-v1";
    }
    if (version?.[1] === "25" && version[2] === "6") {
      return "application-ui-extraction-darwin-25-6-v1";
    }
  }
  throw new Error(
    `No reviewed application baseline for ${environment.platform}/${environment.architecture} ${environment.darwinRelease}. Run on Darwin 25.2, 25.5, or 25.6 arm64, or capture, inspect, and seal a separately approved environment baseline.`,
  );
}

export function assertApplicationBaselineEnvironment(
  environment: ApplicationCaptureEnvironment,
  baselineVersion: string,
): void {
  if (applicationBaselineForEnvironment(environment) !== baselineVersion) {
    throw new Error(`Capture environment does not match ${baselineVersion}`);
  }
}
