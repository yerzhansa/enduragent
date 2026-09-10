import { msg, type Message } from "@enduragent/i18n";
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
  readonly label: Message;
  readonly loading: Message;
  readonly icon: LucideIcon;
  readonly title: Message;
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
    label: msg("sidebar.views.chat"),
    loading: msg("shell.loading.chat"),
    icon: MessageSquare,
    title: msg("sidebar.views.chat"),
    page: REACT_CHAT_REGION,
  },
  {
    id: "archive",
    label: msg("sidebar.views.archive"),
    loading: msg("shell.loading.archive"),
    icon: History,
    title: msg("sidebar.views.archive"),
    page: lazy(async () => ({
      default: (await import("../ui/archive/ArchiveView")).ArchiveView,
    })),
  },
  {
    id: "plan",
    label: msg("sidebar.views.plan"),
    loading: msg("shell.loading.plan"),
    icon: CalendarDays,
    title: msg("sidebar.views.plan"),
    page: lazy(async () => ({
      default: (await import("../ui/plan/PlanView")).PlanView,
    })),
  },
  {
    id: "training",
    label: msg("sidebar.views.training"),
    loading: msg("shell.loading.training"),
    icon: Activity,
    title: msg("sidebar.views.training"),
    page: lazy(async () => ({
      default: (await import("../ui/training/TrainingView")).TrainingView,
    })),
  },
  {
    id: "settings",
    label: msg("sidebar.views.settings"),
    loading: msg("shell.loading.settings"),
    icon: Settings,
    title: msg("sidebar.views.settings"),
    page: lazy(async () => ({
      default: (await loadSettingsView()).SettingsView,
    })),
  },
]);
