import { useEffect, useRef, type ReactElement } from "react";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { Page } from "@enduragent/ui";
import { SetupPanel } from "../onboarding/OnboardingWizard";
import { ApplicationSection } from "./ApplicationSection";
import { CoachSection } from "./CoachSection";
import { ConversationSection } from "./ConversationSection";
import { PreferencesSection } from "./PreferencesSection";
import { takeTrainingRestrictionFocusRequest } from "./restriction-focus";
import { SpendSection } from "./SpendSection";
import { TelegramSection } from "./TelegramSection";
import { TrainingAccountSection } from "./TrainingAccountSection";

export function SettingsView(): ReactElement {
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const busy = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const closeSettingsPanes = useEnduragentStore((store) => store.closeSettingsPanes);
  const restrictionCard = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (takeTrainingRestrictionFocusRequest()) {
      (restrictionCard.current ?? title.current)?.focus();
    }
  }, []);

  useEffect(() => {
    if (ports === null) return;
    ports.panes.activate();
    return () => {
      closeSettingsPanes();
    };
  }, [closeSettingsPanes, ports]);

  return (
    <Page title="Settings" titleRef={title} subtitle={busy ? "Saving…" : undefined} busy={busy}>
      <SetupPanel placement="settings" />
      <TelegramSection />
      <CoachSection />
      <TrainingAccountSection restrictionCard={restrictionCard} />
      <ConversationSection />
      <SpendSection />
      <PreferencesSection />
      <ApplicationSection />
    </Page>
  );
}
