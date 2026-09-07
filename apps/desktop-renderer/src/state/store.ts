import { create } from "zustand";
import type { StoredViewId } from "../app/views";
import {
  applyPalette,
  resolveTheme,
  type Appearance,
  type ResolvedTheme,
} from "@enduragent/ui";
import { publishNativeAppearance } from "../theme/nativeAppearance";
import { paletteById } from "@enduragent/ui";
import {
  readStoredAppearance,
  readStoredPaletteId,
  writeStoredAppearance,
  writeStoredPaletteId,
} from "../theme/preferences";
import { createArchiveSlice, type ArchiveSlice } from "./archive-slice";
import {
  createActivityAnalysisSlice,
  type ActivityAnalysisSlice,
} from "./activity-analysis-slice";
import { createChatSlice, type ChatSlice } from "./chat-slice";
import { createOnboardingSlice, type OnboardingSlice } from "./onboarding-slice";
import { createPlanSlice, type PlanSlice } from "./plan-slice";
import { createRideImportSlice, type RideImportSlice } from "./ride-import-slice";
import {
  createSettingsSlice,
  settingsMutationActive,
  type SettingsSlice,
} from "./settings-slice";
import { createSyncSlice, type SyncSlice } from "./sync-slice";
import { createTrainingSlice, type TrainingSlice } from "./training-slice";
import { createTrainingExportSlice, type TrainingExportSlice } from "./training-export-slice";

export interface EnduragentState
  extends
    ChatSlice,
    ArchiveSlice,
    SettingsSlice,
    TrainingSlice,
    PlanSlice,
    TrainingExportSlice,
    ActivityAnalysisSlice,
    SyncSlice,
    RideImportSlice,
    OnboardingSlice {
  readonly activeView: StoredViewId;
  readonly paletteId: string;
  readonly appearance: Appearance;
  readonly theme: ResolvedTheme;
  readonly runtimeReady: boolean;
  setActiveView: (view: StoredViewId) => void;
  setPaletteId: (paletteId: string) => void;
  setAppearance: (appearance: Appearance) => void;
  refreshTheme: () => void;
  markRuntimeReady: () => void;
}

function stamp(paletteId: string, appearance: Appearance): ResolvedTheme {
  if (typeof document === "undefined") return resolveTheme(appearance);
  return applyPalette({
    root: document.documentElement,
    palette: paletteById(paletteId),
    appearance,
  });
}

export const useEnduragentStore = create<EnduragentState>((set, get, api) => ({
  ...createChatSlice(set, get, api),
  ...createArchiveSlice(set, get, api),
  ...createSettingsSlice(set, get, api),
  ...createTrainingSlice(set, get, api),
  ...createPlanSlice(set, get, api),
  ...createTrainingExportSlice(set, get, api),
  ...createActivityAnalysisSlice(set, get, api),
  ...createSyncSlice(set, get, api),
  ...createRideImportSlice(set, get, api),
  ...createOnboardingSlice(set, get, api),
  activeView: "chat",
  paletteId: readStoredPaletteId(),
  appearance: readStoredAppearance(),
  theme: resolveTheme(readStoredAppearance()),
  runtimeReady: false,
  setActiveView(view) {
    const current = get();
    if (current.activeView === "settings" && settingsMutationActive(current.settings)) return;
    set({ activeView: view });
  },
  setPaletteId(paletteId) {
    writeStoredPaletteId(paletteId);
    set({ paletteId, theme: stamp(paletteId, get().appearance) });
  },
  setAppearance(appearance) {
    writeStoredAppearance(appearance);
    publishNativeAppearance(appearance);
    set({ appearance, theme: stamp(get().paletteId, appearance) });
  },
  refreshTheme() {
    const { paletteId, appearance } = get();
    set({ theme: stamp(paletteId, appearance) });
  },
  markRuntimeReady() {
    set({ runtimeReady: true });
  },
}));

export function bootTheme(): ResolvedTheme {
  const { paletteId, appearance } = useEnduragentStore.getState();
  publishNativeAppearance(appearance);
  const theme = stamp(paletteId, appearance);
  useEnduragentStore.setState({ theme });
  return theme;
}
