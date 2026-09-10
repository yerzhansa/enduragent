import type { Phrasebook } from "@enduragent/i18n/messages";
import { desktopPhrasebook } from "./language.js";
import type { DesktopDaemonResolution } from "@enduragent/coach/enduragent";
import type { DesktopDaemonLifecycleState } from "./daemon-lifecycle.js";
import { desktopPlatformProjection, desktopPlatformTokens } from "./platform-copy.js";

export interface DesktopErrorCopy {
  readonly title: string;
  readonly content: string;
}

export function startupRefusalCopy(
  cause: Extract<DesktopDaemonResolution, { status: "refused" }>["cause"],
  platform: NodeJS.Platform = process.platform,
  phrasebook: Phrasebook = desktopPhrasebook(),
): DesktopErrorCopy {
  const { product } = desktopPlatformTokens(platform);
  const vars = { product, configFile: "config.yaml" };
  if (cause === "not-configured") {
    return {
      title: phrasebook.say("desktop.lifecycle.notConfiguredTitle", vars),
      content: phrasebook.say("desktop.lifecycle.notConfiguredContent", vars),
    };
  }
  if (cause === "unreadable") {
    return {
      title: phrasebook.say("desktop.lifecycle.unreadableTitle", vars),
      content: phrasebook.say("desktop.lifecycle.unreadableContent", vars),
    };
  }
  if (cause === "malformed") {
    return {
      title: phrasebook.say("desktop.lifecycle.malformedTitle", vars),
      content: phrasebook.say("desktop.lifecycle.malformedContent", vars),
    };
  }
  if (cause === "contention") {
    return {
      title: phrasebook.say("desktop.lifecycle.contentionTitle", vars),
      content: phrasebook.say("desktop.lifecycle.contentionContent", vars),
    };
  }
  if (cause === "version-mismatch") {
    return {
      title: phrasebook.say("desktop.lifecycle.versionMismatchTitle", vars),
      content: phrasebook.say("desktop.lifecycle.versionMismatchContent", vars),
    };
  }
  return {
    title: phrasebook.say("desktop.lifecycle.unavailableTitle", vars),
    content: phrasebook.say("desktop.lifecycle.unavailableContent", {
      ...vars,
      restartComputer: desktopPlatformProjection(platform, phrasebook).copy.restartComputer,
    }),
  };
}

export const unexpectedStartupCopy: DesktopErrorCopy = {
  get title() {
    return desktopPhrasebook().say("desktop.lifecycle.unexpectedTitle", {
      product: desktopPlatformTokens().product,
    });
  },
  get content() {
    return desktopPhrasebook().say("desktop.lifecycle.unexpectedContent", {
      product: desktopPlatformTokens().product,
    });
  },
};

export const restartExhaustedCopy: DesktopErrorCopy = {
  get title() {
    return desktopPhrasebook().say("desktop.lifecycle.restartExhaustedTitle", {
      product: desktopPlatformTokens().product,
    });
  },
  get content() {
    return desktopPhrasebook().say("desktop.lifecycle.restartExhaustedContent", {
      product: desktopPlatformTokens().product,
    });
  },
};

export function lifecycleErrorCopy(
  state: DesktopDaemonLifecycleState,
): DesktopErrorCopy | undefined {
  if (state.status !== "terminal" || state.cause === "cancelled") return undefined;
  if (state.cause === "restart-exhausted") return restartExhaustedCopy;
  return startupRefusalCopy(state.cause);
}
