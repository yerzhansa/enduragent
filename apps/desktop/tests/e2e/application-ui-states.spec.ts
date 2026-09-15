import { test } from "@playwright/test";
import { applicationScenarios } from "./application-ui-states/identity.js";
import {
  verifyNativeScenario,
  verifySettingsMutationRecovery,
} from "./application-ui-states/scenarios.js";

test.describe("production application UI states", () => {
  for (const scenario of applicationScenarios) {
    test(scenario, async ({ browserName: _browserName }, info) => {
      await verifyNativeScenario(scenario, info);
    });

    if (scenario === "desktop--settings-preferences") {
      test("second-row regression fails structure and image comparison, then recovers", async ({
        browserName: _browserName,
      }, info) => {
        await verifySettingsMutationRecovery(info);
      });
    }
  }
});
