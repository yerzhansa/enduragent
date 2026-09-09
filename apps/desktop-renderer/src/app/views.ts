import {
  Activity,
  CalendarDays,
  History,
  MessageSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type ViewId = "chat" | "archive" | "plan" | "training" | "settings";
export type StoredViewId = ViewId;

export const REACT_CHAT_REGION = "react-chat-region";

export interface ViewDefinition {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly page: LazyExoticComponent<ComponentType> | typeof REACT_CHAT_REGION;
}

let settingsViewPromise: Promise<typeof import("../ui/settings/SettingsView")> | undefined;

export function loadSettingsView(): Promise<typeof import("../ui/settings/SettingsView")> {
  settingsViewPromise ??= import("../ui/settings/SettingsView");
  return settingsViewPromise;
}

export const VIEWS: readonly ViewDefinition[] = Object.freeze([
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    title: "Chat",
    page: REACT_CHAT_REGION,
  },
  {
    id: "archive",
    label: "Past chats",
    icon: History,
    title: "Past chats",
    page: lazy(async () => ({
      default: (await import("../ui/archive/ArchiveView")).ArchiveView,
    })),
  },
  {
    id: "plan",
    label: "Plan",
    icon: CalendarDays,
    title: "Plan",
    page: lazy(async () => ({
      default: (await import("../ui/plan/PlanView")).PlanView,
    })),
  },
  {
    id: "training",
    label: "Training",
    icon: Activity,
    title: "Training",
    page: lazy(async () => ({
      default: (await import("../ui/training/TrainingView")).TrainingView,
    })),
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    title: "Settings",
    page: lazy(async () => ({
      default: (await loadSettingsView()).SettingsView,
    })),
  },
]);
