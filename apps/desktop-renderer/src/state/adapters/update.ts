import type { DesktopUpdatePendingAction, DesktopUpdateView } from "../../update/controller";
import type { UpdateSettingsPort, UpdateSurfaceState } from "../settings-slice";

export interface UpdateSettingsAdapter {
  readonly view: DesktopUpdateView;
  readonly port: UpdateSettingsPort;
}

export function createUpdateSettingsAdapter(input: {
  readonly publish: (next: UpdateSurfaceState) => void;
}): UpdateSettingsAdapter {
  let handler: (() => void) | undefined;
  let disposed = false;
  return {
    view: {
      bind(next) {
        handler = next;
      },
      render(state, options) {
        if (disposed) return;
        const pendingAction: DesktopUpdatePendingAction = options?.pendingAction ?? "none";
        input.publish({ state, pendingAction });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        handler = undefined;
      },
    },
    port: {
      activate: () => handler?.(),
    },
  };
}
