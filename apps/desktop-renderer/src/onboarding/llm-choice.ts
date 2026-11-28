import type { OnboardingLlmConfiguration, OnboardingLlmSelection } from "./bridge";
import type { ChatGptStatus, CredentialSlotStatus } from "./machine";
import {
  draftForProvider,
  draftOnConfiguration,
  initialLlmDraft,
  withSavedSelection,
  type LlmSelectionDraft,
} from "./selection";

export type LlmDraftEdit = Partial<
  Pick<LlmSelectionDraft, "modelChoice" | "customModel" | "endpointMode" | "customEndpoint">
>;

type ConfigurationRead = (
  configuration: OnboardingLlmConfiguration,
  statuses: readonly CredentialSlotStatus[],
  chatGpt: ChatGptStatus,
) => void;

export interface LlmChoice {
  configuration(): OnboardingLlmConfiguration | undefined;
  draft(): LlmSelectionDraft | undefined;
  readonly adopt: ConfigurationRead;
  readonly follow: ConfigurationRead;
  choose(provider: string): boolean;
  edit(change: LlmDraftEdit): boolean;
  recordActive(selection: OnboardingLlmSelection): boolean;
}

export function createLlmChoice(): LlmChoice {
  let configuration: OnboardingLlmConfiguration | undefined;
  let draft: LlmSelectionDraft | undefined;
  let editedByAthlete = false;
  let drafts: Readonly<Record<string, LlmSelectionDraft>> = {};

  const show = (next: LlmSelectionDraft | undefined, byAthlete: boolean): void => {
    draft = next;
    editedByAthlete = byAthlete;
    if (next !== undefined) drafts = { ...drafts, [next.provider.provider]: next };
  };

  const adopt: ConfigurationRead = (next, statuses, chatGpt) => {
    configuration = next;
    drafts = {};
    show(initialLlmDraft(next, statuses, chatGpt), false);
  };

  return {
    configuration: () => configuration,
    draft: () => draft,
    adopt,
    follow(next, statuses, chatGpt) {
      const kept =
        editedByAthlete && draft !== undefined ? draftOnConfiguration(draft, next) : undefined;
      if (kept === undefined) {
        adopt(next, statuses, chatGpt);
        return;
      }
      configuration = next;
      drafts = Object.fromEntries(
        Object.entries(drafts).flatMap(([provider, entry]) => {
          const moved = draftOnConfiguration(entry, next);
          return moved === undefined ? [] : [[provider, moved] as const];
        }),
      );
      show(kept, true);
    },
    choose(provider) {
      const entry = configuration?.providers.find((candidate) => candidate.provider === provider);
      if (configuration === undefined || entry === undefined) return false;
      show(drafts[entry.provider] ?? draftForProvider(entry, configuration.catalogRevision), true);
      return true;
    },
    edit(change) {
      if (draft === undefined) return false;
      show({ ...draft, ...change }, true);
      return true;
    },
    recordActive(selection) {
      if (configuration === undefined) return false;
      configuration = withSavedSelection(configuration, selection);
      editedByAthlete = false;
      return true;
    },
  };
}

function sameChoice(left: OnboardingLlmSelection, right: OnboardingLlmSelection): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(left.endpoint) === JSON.stringify(right.endpoint)
  );
}

export async function sendOnCurrentCatalog<Result extends { readonly status: string }>(
  selection: OnboardingLlmSelection,
  send: (selection: OnboardingLlmSelection) => Promise<Result>,
  followCatalog: () => Promise<OnboardingLlmSelection | null>,
): Promise<{ readonly result: Result; readonly selection: OnboardingLlmSelection }> {
  const result = await send(selection);
  if (result.status !== "stale-draft") return { result, selection };
  const followed = await followCatalog();
  return followed === null || !sameChoice(followed, selection)
    ? { result, selection }
    : { result: await send(followed), selection: followed };
}
