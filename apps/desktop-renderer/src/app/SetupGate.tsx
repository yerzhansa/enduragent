import type { ReactElement } from "react";
import { SetupPanel } from "../ui/onboarding/OnboardingWizard";

export function SetupGate(): ReactElement {
  return (
    <main
      className="grid min-h-0 place-items-center overflow-auto px-6 pt-10 pb-14"
      aria-labelledby="setup-panel-title"
      lang="en"
    >
      <SetupPanel placement="gate" />
    </main>
  );
}
