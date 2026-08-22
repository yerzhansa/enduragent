import type {
  AthleteSettingsState,
  AthleteSettingsView,
} from "../../settings/athlete-controller.js";
import type {
  CredentialSettingsState,
  CredentialSettingsView,
} from "../../settings/credential-controller.js";
import type {
  ProviderModelSettingsState,
  ProviderModelSettingsView,
} from "../../settings/provider-model-controller.js";
import type {
  SessionSettingsState,
  SessionSettingsView,
} from "../../settings/session-controller.js";
import {
  CLOSED_PANE,
  type AthleteSettingsPort,
  type CoachSettingsPort,
  type ConversationSettingsPort,
  type CredentialSettingsPort,
} from "../settings-slice.js";

export interface CoachSettingsAdapter {
  readonly view: ProviderModelSettingsView;
  readonly port: CoachSettingsPort;
}

export interface CredentialSettingsAdapter {
  readonly view: CredentialSettingsView;
  readonly port: CredentialSettingsPort;
}

export interface AthleteSettingsAdapter {
  readonly view: AthleteSettingsView;
  readonly port: AthleteSettingsPort;
}

export interface ConversationSettingsAdapter {
  readonly view: SessionSettingsView;
  readonly port: ConversationSettingsPort;
}

export function createCoachSettingsAdapter(input: {
  readonly publish: (state: ProviderModelSettingsState) => void;
}): CoachSettingsAdapter {
  let handlers: Parameters<ProviderModelSettingsView["bind"]>[0] | undefined;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      open() {},
      close() {
        input.publish(CLOSED_PANE);
      },
      render(state) {
        input.publish(state);
      },
      dispose() {
        handlers = undefined;
        input.publish(CLOSED_PANE);
      },
    },
    port: {
      retry: () => handlers?.onRetry(),
      changeProvider: (provider) => handlers?.onProviderChange(provider),
      changeModel: (model) => handlers?.onModelChange(model),
      changeCustomModel: (model) => handlers?.onCustomModelChange(model),
      save: () => handlers?.onSave(),
      openSetup: () => handlers?.onOpenSetup(),
    },
  };
}

export function createCredentialSettingsAdapter(input: {
  readonly publish: (state: CredentialSettingsState) => void;
}): CredentialSettingsAdapter {
  let handlers: Parameters<CredentialSettingsView["bind"]>[0] | undefined;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      render(state) {
        input.publish(state);
      },
      dispose() {
        handlers = undefined;
        input.publish(CLOSED_PANE);
      },
    },
    port: {
      retry: () => handlers?.onRetry(),
      requestDelete: (credential) => handlers?.onRequestDelete(credential),
      requestReset: () => handlers?.onRequestReset(),
      cancelDelete: () => handlers?.onCancelDelete(),
      confirmDelete: () => handlers?.onConfirmDelete(),
      setupOpened: () => handlers?.onSetupOpened(),
      openSetup: () => handlers?.onOpenSetup(),
    },
  };
}

export function createAthleteSettingsAdapter(input: {
  readonly publish: (state: AthleteSettingsState) => void;
}): AthleteSettingsAdapter {
  let handlers: Parameters<AthleteSettingsView["bind"]>[0] | undefined;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      render(state) {
        input.publish(state);
      },
      dispose() {
        handlers = undefined;
        input.publish(CLOSED_PANE);
      },
    },
    port: {
      retry: () => handlers?.onRetry(),
      change: (value) => handlers?.onChange(value),
      save: () => handlers?.onSave(),
      openSetup: () => handlers?.onOpenSetup(),
    },
  };
}

export function createConversationSettingsAdapter(input: {
  readonly publish: (state: SessionSettingsState) => void;
}): ConversationSettingsAdapter {
  let handlers: Parameters<SessionSettingsView["bind"]>[0] | undefined;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      render(state) {
        input.publish(state);
      },
      dispose() {
        handlers = undefined;
        input.publish(CLOSED_PANE);
      },
    },
    port: {
      retry: () => handlers?.onRetry(),
      change: (field, value) => handlers?.onChange(field, value),
      save: () => handlers?.onSave(),
    },
  };
}
