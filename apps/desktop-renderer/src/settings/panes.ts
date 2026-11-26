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

const IDLE_COACH_STATES: ReadonlySet<string> = new Set(["ready", "saved", "error"]);
const IDLE_CREDENTIAL_STATES: ReadonlySet<string> = new Set(["ready", "deleted"]);

function reload(pane: SettingsPane): void {
  pane.close();
  void pane.activate();
}

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
      if (IDLE_COACH_STATES.has(input.coach.state().status)) reload(input.coach);
      if (IDLE_CREDENTIAL_STATES.has(input.credentials.state().status)) reload(input.credentials);
    },
  };
}
