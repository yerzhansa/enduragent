import type { ReactElement } from "react";
import { usePhrasebook } from "@enduragent/i18n/react";
import { SetupPanel } from "../ui/onboarding/OnboardingWizard";

export function SetupGate(): ReactElement {
  const { tag } = usePhrasebook();
  return (
    <main
      className="grid min-h-0 place-items-center overflow-auto px-6 pt-10 pb-14"
      aria-labelledby="setup-panel-title"
      lang={tag}
    >
      <SetupPanel placement="gate" />
    </main>
  );
}
