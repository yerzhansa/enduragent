import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { commitmentSummaryId } from "./PlanCreationDraftCards";
import { creationProgressCopy } from "./plan-creation-progress";

function usePlanCreationChrome(): {
  readonly model: PlanCreationCardModel;
  readonly title: string;
  readonly status: "Paused" | "In progress";
  readonly summary: string;
  readonly buildDraft: boolean;
  readonly canContinue: boolean;
} | null {
  const model = useEnduragentStore((state) => state.chat.planCreation);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const library = useEnduragentStore((state) => state.planLibrary.value);
  if (model === null) return null;
  const copy = creationProgressCopy({
    model,
    paused,
    libraryLoaded: library !== null,
    activePlanName: library?.active?.name ?? null,
  });
  return {
    model,
    ...copy,
    buildDraft: model.readiness === "ready" && model.draft === null,
    canContinue: paused && model.openQuestion !== null,
  };
}

export function PlanCreationSubtitle(): ReactElement | null {
  const chrome = usePlanCreationChrome();
  if (chrome === null) return null;
  return (
    <p
      className="m-0 min-w-0 truncate text-xs leading-4 text-ink-2"
      title={`Plan creation · ${chrome.title} · ${chrome.status} · ${chrome.summary}`}
    >
      <span data-parity="progress.eyebrow">Plan creation</span>
      {" · "}
      <span data-parity="progress.title">{chrome.title}</span>
      {" · "}
      <span data-parity="progress.status">{chrome.status}</span>
      {" · "}
      <span data-parity="progress.summary">{chrome.summary}</span>
    </p>
  );
}

export function PlanCreationHeaderActions(): ReactElement | null {
  const chrome = usePlanCreationChrome();
  const actions = useEnduragentStore((state) => state.chatActions);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const discardButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusRequest?.target === "discard") {
      queueMicrotask(() => discardButton.current?.focus());
    }
  }, [focusRequest?.revision, focusRequest?.target]);
  if (chrome === null) return null;
  return (
    <div className="flex items-center gap-2" data-parity="progress.actions">
      <Button
        ref={discardButton}
        type="button"
        size="xs"
        variant="destructive"
        className="border-[color-mix(in_srgb,var(--danger)_52%,var(--line))] bg-transparent"
        data-plan-creation-discard={chrome.model.creationId}
        aria-haspopup="dialog"
        disabled={busy || actions === null}
        onClick={() => actions?.openPlanCreationDiscard()}
      >
        Discard
      </Button>
      {chrome.buildDraft ? (
        <Button
          type="button"
          size="xs"
          disabled={
            actions === null ||
            busy ||
            editingKey !== null ||
            chrome.model.pendingCommitment !== null
          }
          aria-describedby={
            chrome.model.pendingCommitment === null ? undefined : commitmentSummaryId(chrome.model)
          }
          onClick={() => actions?.buildPlanCreationDraft()}
        >
          Build Draft
        </Button>
      ) : null}
      {chrome.canContinue ? (
        <Button
          type="button"
          size="xs"
          variant="default"
          disabled={actions === null || busy}
          onClick={() => actions?.continuePlanCreation()}
        >
          Continue
        </Button>
      ) : null}
    </div>
  );
}
