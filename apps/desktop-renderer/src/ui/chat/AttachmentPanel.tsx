import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerItem,
} from "@enduragent/coach-contract";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  Check,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

function bytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1_024))} KB`;
}

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function distance(meters: number | null): string {
  return meters === null ? "—" : `${(meters / 1_000).toFixed(1)} km`;
}

function formatDate(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
    new Date(seconds * 1_000),
  );
}

function AttachmentIcon(props: { readonly kind: ChatAttachmentComposerItem["kind"] }) {
  const Icon =
    props.kind === "activity"
      ? Activity
      : props.kind === "workout"
        ? CalendarDays
        : props.kind === "image"
          ? ImageIcon
          : FileText;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-bg-2 text-accent">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

function Note(props: {
  readonly tone?: "normal" | "warning" | "activity";
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactElement;
}): ReactElement {
  const warning = props.tone === "warning";
  const Icon = warning ? AlertTriangle : props.tone === "activity" ? Activity : Check;
  const iconTone = warning
    ? "bg-danger/14 text-danger"
    : props.tone === "activity"
      ? "bg-accent/14 text-accent"
      : "bg-ok/14 text-ok";
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-t border-line bg-bg-2 px-4 py-3 max-[760px]:grid-cols-[32px_minmax(0,1fr)]">
      <span className={`flex size-8 items-center justify-center rounded-md ${iconTone}`}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <strong className="block text-sm text-ink">{props.title}</strong>
        <p className="mt-1 mb-0 text-xs leading-5 text-ink-2">{props.children}</p>
      </div>
      {props.action === undefined ? null : (
        <span className="max-[760px]:col-start-2">{props.action}</span>
      )}
    </div>
  );
}

function ReadyPreview(props: { readonly attachment: ChatAttachmentComposerItem }): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const planningRequestsLoaded = useEnduragentStore((state) => state.chat.planningRequestsLoaded);
  const planningRequestBusyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  const attachment = props.attachment;
  if (attachment.status !== "ready") throw new TypeError("attachment is not ready");
  if (attachment.preview.kind === "document") {
    const scanned = attachment.preview.extractedTextChars === 0;
    return (
      <Note title={scanned ? "Stored locally — no text found" : "Stored locally"}>
        {scanned
          ? "Coach can inspect visual PDF pages when image input is available; OCR is not used."
          : "Coach can read this file through managed attachment tools."}
      </Note>
    );
  }
  if (attachment.preview.kind === "activity") {
    const session = attachment.preview.sessions[0]!;
    return (
      <>
        <div className="grid grid-cols-3 divide-x divide-line border-t border-line max-[760px]:grid-cols-1 max-[760px]:divide-x-0 max-[760px]:divide-y">
          <div className="px-4 py-3">
            <span className="block text-xs text-ink-2">Date</span>
            <strong className="mt-1 block text-sm">{formatDate(session.startUtc)}</strong>
          </div>
          <div className="px-4 py-3">
            <span className="block text-xs text-ink-2">Duration</span>
            <strong className="mt-1 block text-sm">{duration(session.durationSeconds)}</strong>
          </div>
          <div className="px-4 py-3">
            <span className="block text-xs text-ink-2">Distance</span>
            <strong className="mt-1 block text-sm">{distance(session.distanceMeters)}</strong>
          </div>
        </div>
        <Note tone="activity" title="Will add to Training when sent">
          Send confirms the import; Plan and Calendar stay unchanged.
        </Note>
      </>
    );
  }
  if (attachment.preview.kind === "workout") {
    const preview = attachment.preview;
    const selected = preview.workouts.find(
      (workout) => workout.workoutId === preview.selectedWorkoutId,
    );
    return (
      <>
        <fieldset className="m-0 grid gap-1 border-0 border-t border-line p-2">
          <legend className="px-2 py-1 text-xs text-ink-2">Select a workout</legend>
          {preview.workouts.map((workout) => {
            const workoutSelected = workout.workoutId === preview.selectedWorkoutId;
            return (
              <button
                key={workout.workoutId}
                type="button"
                className={`grid min-h-12 w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-3 rounded-md border px-3 py-2 text-left ${workoutSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-bg-2"}`}
                aria-pressed={workoutSelected}
                onClick={() => {
                  actions?.selectAttachmentWorkout(attachment.attachmentId, workout.workoutId);
                }}
              >
                <span
                  className={`flex size-4 items-center justify-center rounded-full border ${workoutSelected ? "border-accent" : "border-ink-3"}`}
                  aria-hidden="true"
                >
                  {workoutSelected ? <span className="size-2 rounded-full bg-accent" /> : null}
                </span>
                <span className="min-w-0">
                  <strong className="block text-sm">{workout.title}</strong>
                  <small className="mt-1 block text-xs text-ink-2">
                    {duration(workout.durationSeconds)} · {workout.target}
                    {workout.purpose === null ? "" : ` · ${workout.purpose}`}
                  </small>
                </span>
              </button>
            );
          })}
        </fieldset>
        {selected === undefined ? null : (
          <Note
            title={`${selected.title} selected`}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  actions === null || !planningRequestsLoaded || planningRequestBusyId !== null
                }
                onClick={() => actions?.reviewAttachmentInPlan(attachment.attachmentId)}
              >
                {planningRequestBusyId === null ? "Review in Plan" : "Opening Plan…"}
              </Button>
            }
          >
            Send asks Coach to analyze it, or review it in Plan now.
          </Note>
        )}
      </>
    );
  }
  return (
    <Note title="Image input available">
      The configured model can view this image ({attachment.preview.width} ×{" "}
      {attachment.preview.height}).
    </Note>
  );
}

function AttachmentCard(props: { readonly attachment: ChatAttachmentComposerItem }): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const attachment = props.attachment;
  return (
    <section
      className="overflow-hidden rounded-card border border-line-2 bg-surface shadow-elev-2"
      aria-label={`${attachment.displayName} attachment`}
    >
      <div className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2">
        <AttachmentIcon kind={attachment.kind} />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{attachment.displayName}</strong>
          <small className="mt-1 block text-xs text-ink-2">
            {attachment.extension.toUpperCase()} · {bytes(attachment.byteSize)}
            {attachment.status === "preprocessing" ? " · processing locally" : ""}
          </small>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            actions?.removeAttachment(attachment.attachmentId);
          }}
        >
          Remove
        </Button>
      </div>
      {attachment.status === "preprocessing" ? (
        <Note title="Processing locally">
          The file is being checked and prepared without sending its raw contents to a provider.
        </Note>
      ) : null}
      {attachment.status === "blocked" ? (
        <Note
          tone="warning"
          title={
            attachment.reason === "encrypted_pdf"
              ? "This PDF is password protected"
              : "This model can’t view this file"
          }
          action={
            attachment.reason === "encrypted_pdf" ? undefined : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setActiveView("settings")}
              >
                Open Settings
              </Button>
            )
          }
        >
          {attachment.reason === "encrypted_pdf"
            ? "Choose an unlocked PDF; the current draft is preserved."
            : "Remove it or choose a compatible model in Settings."}
        </Note>
      ) : null}
      {attachment.status === "failed" ? (
        <Note
          tone="warning"
          title="This file couldn’t be prepared"
          action={
            attachment.retryable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  actions?.retryAttachment(attachment.attachmentId);
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          Your message draft is safe. Remove this file or try it again.
        </Note>
      ) : null}
      {attachment.status === "ready" ? <ReadyPreview attachment={attachment} /> : null}
    </section>
  );
}

function AdmissionFailure(props: {
  readonly admission: AttachmentAdmissionReadModel;
}): ReactElement | null {
  const actions = useEnduragentStore((state) => state.chatActions);
  const admission = props.admission;
  if (admission.status !== "rejected" && admission.status !== "storage_failed") return null;
  const unsupported = admission.status === "rejected" && admission.reason === "format_unsupported";
  return (
    <section
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-card border border-danger/40 bg-surface p-4 shadow-elev-2 max-[760px]:grid-cols-1"
      role="alert"
    >
      <div className="col-span-full flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-md bg-bg-2 text-danger">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{admission.displayName}</strong>
          <small className="mt-1 block text-xs text-ink-2">
            {unsupported ? "Unknown format" : "Could not add file"}
          </small>
        </div>
      </div>
      <div>
        <strong className="block text-sm text-ink">
          {unsupported ? "This file type isn’t supported" : "Your draft is safe"}
        </strong>
        <p className="mt-1 mb-0 text-xs leading-5 text-ink-2">
          {unsupported
            ? "Try FIT, TCX, GPX, ZWO, ERG, MRC, PDF, TXT, CSV, DOCX, PNG, JPG, or WEBP."
            : "Choose the file again; no message was sent."}
        </p>
      </div>
      <div className="flex gap-2 max-[760px]:justify-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void actions?.chooseAttachments()}
        >
          Choose another file
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => actions?.receiveAttachmentAdmissions([])}
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}

export function AttachmentPanel(): ReactElement | null {
  const surface = useEnduragentStore((state) => state.chat);
  const actions = useEnduragentStore((state) => state.chatActions);
  const attachments = surface.attachments?.draft?.attachments ?? [];
  if (
    attachments.length === 0 &&
    surface.attachmentAdmissions.length === 0 &&
    !surface.attachmentBusy &&
    surface.attachmentError === null &&
    surface.planningRequestError === null
  ) {
    return null;
  }
  return (
    <div className="mb-2.5 grid gap-2.5" aria-live="polite">
      {surface.attachmentBusy ? (
        <div className="flex items-center gap-3 rounded-card border border-line-2 bg-surface p-4 text-sm text-ink-2">
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Adding files…
        </div>
      ) : null}
      {surface.attachmentError === null ? null : (
        <div
          className="rounded-card border border-danger/40 bg-surface p-4 text-sm text-danger"
          role="alert"
        >
          {surface.attachmentError}
        </div>
      )}
      {surface.planningRequestError === null ? null : (
        <div
          className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-surface p-4 text-sm text-danger"
          role="alert"
        >
          <span>{surface.planningRequestError}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={surface.planningRequestBusyId !== null}
            onClick={() => actions?.retryPlanningRequestLoad()}
          >
            Try again
          </Button>
        </div>
      )}
      {surface.attachmentAdmissions.map((admission) => (
        <AdmissionFailure key={admission.selectionId} admission={admission} />
      ))}
      {attachments.map((attachment) => (
        <AttachmentCard key={attachment.attachmentId} attachment={attachment} />
      ))}
    </div>
  );
}
