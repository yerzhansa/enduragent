import { PLAN_CALENDAR_NOTE_MAX } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useId, useState, type ReactElement } from "react";
import type { RideReviewState } from "../../activity-review/review-controller";
import type { ActivityReviewActions } from "../../state/activity-review-slice";

type Ready = Extract<RideReviewState, { kind: "ready" }>;

function NoteStatus(props: { readonly note: Ready["note"] }): ReactElement | null {
  const { say } = usePhrasebook();
  switch (props.note) {
    case "idle":
      return null;
    case "saving":
      return (
        <span className="text-xs text-ink-2" role="status">
          {say("activity.review.note.saving")}
        </span>
      );
    case "saved":
      return (
        <span className="text-xs text-ink-2" role="status">
          {say("activity.review.note.saved")}
        </span>
      );
    case "failed":
      return (
        <span className="text-xs text-warn" role="alert">
          {say("activity.review.note.failed")}
        </span>
      );
  }
}

function NoteField(props: {
  readonly state: Ready;
  readonly actions: ActivityReviewActions | null;
}): ReactElement {
  const { say } = usePhrasebook();
  const id = useId();
  const saved = props.state.review.note?.text ?? "";
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  if (saved !== base) {
    setBase(saved);
    if (draft === base) setDraft(saved);
  }
  const unchanged = draft.trim() === saved;
  const status = props.state.note === "saved" && !unchanged ? "idle" : props.state.note;
  return (
    <div className="flex flex-col gap-1.5" data-ride-note="">
      <label htmlFor={id} className="text-sm font-semibold">
        {say("activity.review.note.title")}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={PLAN_CALENDAR_NOTE_MAX}
        value={draft}
        placeholder={say("activity.review.note.placeholder")}
        aria-describedby={`${id}-hint`}
        className="min-h-16 resize-y rounded-ctl border border-line-2 bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
        onChange={(event) => setDraft(event.target.value)}
      />
      <span id={`${id}-hint`} className="text-xs text-ink-2">
        {say("activity.review.note.hint")}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={unchanged || props.state.note === "saving"}
          onClick={() => props.actions?.saveNote(draft)}
        >
          {say("activity.review.note.save")}
        </Button>
        <NoteStatus note={status} />
      </div>
    </div>
  );
}

export function RideNote(props: {
  readonly state: RideReviewState;
  readonly actions: ActivityReviewActions | null;
}): ReactElement | null {
  if (props.state.kind !== "ready") return null;
  return <NoteField key={props.state.activityId} state={props.state} actions={props.actions} />;
}
