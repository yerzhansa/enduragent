import { expect, test } from "./fixtures/desktop-app.js";

const RETIRED_MODELS = [
  {
    provider: "minimax",
    providerLabel: "MiniMax",
    saved: "MiniMax-M2.7-highspeed",
    savedLabel: "MiniMax M2.7 Highspeed",
    replacement: "MiniMax M3.1 Flash",
  },
  {
    provider: "google",
    providerLabel: "Google",
    saved: "gemini-3.7-flash",
    savedLabel: "Gemini 3.7 Flash",
    replacement: "Gemini 3.8 Flash",
  },
] as const;

function pickerShows(label: string): RegExp {
  return new RegExp(`^${label.replaceAll(".", "\\.")}( ·|▼|$)`);
}

function savedConfig(provider: string, model: string): string {
  return [
    "data_source: store",
    "llm:",
    `  provider: ${provider}`,
    `  model: ${model}`,
    "  api_key: obviously-fake-provider-key",
    "intervals:",
    "  api_key: ''",
    "  athlete_id: ''",
    "session:",
    "  timezone: UTC",
    "",
  ].join("\n");
}

for (const retired of RETIRED_MODELS) {
  test.describe(`an athlete who saved ${retired.savedLabel}`, () => {
    test.use({
      recordDesktopVideo: process.env.ENDURAGENT_E2E_VIDEO === "1",
      savedConfig: savedConfig(retired.provider, retired.saved),
    });

    test(`is offered ${retired.replacement} after its provider retired the saved model`, async ({
      desktop,
    }) => {
      const page = desktop.page;
      const shell = page.locator("[data-shell]");
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });

      await page.getByRole("button", { name: "Choose" }).click();
      await page.getByText("API key", { exact: true }).click();
      const form = page.locator("[data-setup-panel]").or(page.locator("main"));
      await expect(
        form.getByText("Provider", { exact: true }),
        "the API key form should open",
      ).toBeVisible();
      await expect(
        page.getByRole("combobox").first(),
        `Setup should keep the athlete's saved provider, ${retired.providerLabel}`,
      ).toHaveText(pickerShows(retired.providerLabel));

      await page.getByText("Advanced", { exact: true }).click();
      const modelPicker = page.getByRole("combobox").nth(1);
      await expect(modelPicker).toBeVisible();
      await expect(
        modelPicker,
        `${retired.providerLabel} retired ${retired.savedLabel}, so the Model picker should offer ${retired.replacement}, not the retired model`,
      ).toHaveText(pickerShows(retired.replacement));
    });
  });
}
