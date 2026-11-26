import type { CredentialSettingsController } from "./credential-controller";
import type { ProviderModelSettingsController } from "./provider-model-controller";

interface SettingsPane {
  activate(): Promise<void>;
  close(): void;
}

export interface SettingsPanes {
  activate(): void;
  close(): void;
  reloadAfterSetup(): void;
}

const IDLE_CREDENTIAL_STATES: ReadonlySet<string> = new Set(["ready", "deleted"]);

export function createSettingsPanes(input: {
  readonly coach: ProviderModelSettingsController;
  readonly credentials: CredentialSettingsController;
  readonly others: readonly SettingsPane[];
  readonly onActivate?: () => void;
}): SettingsPanes {
  const panes = [input.coach, input.credentials, ...input.others];
  return {
    activate() {
      input.onActivate?.();
      for (const pane of panes) void pane.activate();
    },
    close() {
      for (const pane of panes) pane.close();
    },
    reloadAfterSetup() {
      if (input.coach.state().status !== "closed") void input.coach.refresh();
      if (IDLE_CREDENTIAL_STATES.has(input.credentials.state().status)) {
        void input.credentials.refresh();
      }
    },
  };
}
