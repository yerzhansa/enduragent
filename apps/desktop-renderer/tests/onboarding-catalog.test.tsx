import { screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { SetupPanel } from "../src/ui/onboarding/OnboardingWizard";
import { renderWithCatalog } from "./language-harness";
import { resetOnboardingStore } from "./onboarding-harness";

afterEach(resetOnboardingStore);

it("reads setup headings, actions, and accessible labels from the selected catalog", async () => {
  resetOnboardingStore();
  useEnduragentStore.setState((state) => ({
    onboarding: READY_ONBOARDING,
    settings: { ...state.settings, language: { ...state.settings.language, value: "it" } },
  }));
  await renderWithCatalog(<SetupPanel placement="gate" />, {
    setup: {
      heading: "Prepara il tuo allenatore",
      startCoaching: "Inizia",
      ai: { title: "Intelligenza del tuo allenatore", trigger: { unset: "Scegli intelligenza" } },
      training: { trigger: { disconnected: "Collega allenamenti" } },
      telegram: { createLabel: "Crea un bot" },
      intake: { title: "Condizione attuale" },
    },
  });
  expect(screen.getByRole("heading", { name: "Prepara il tuo allenatore" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inizia" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Scegli intelligenza" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collega allenamenti" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Crea un bot" })).toBeInTheDocument();
  expect(screen.getByText("Condizione attuale")).toBeInTheDocument();
});
