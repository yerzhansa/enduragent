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
  let open = false;
  return {
    activate() {
      open = true;
      input.onActivate?.();
      for (const pane of panes) void pane.activate();
    },
    close() {
      open = false;
      for (const pane of panes) pane.close();
    },
    reloadAfterSetup() {
      if (!open) return;
      void input.coach.refresh();
      const credentialStatus = input.credentials.state().status;
      if (credentialStatus === "closed") void input.credentials.activate();
      else if (IDLE_CREDENTIAL_STATES.has(credentialStatus)) void input.credentials.refresh();
    },
  };
}
