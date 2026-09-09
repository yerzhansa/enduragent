import { chatFeedbackMessage } from "./copy";
import { usePhrasebook } from "@enduragent/i18n/react";
import { AttachmentList, AttachmentPreview, EvidenceList, NoticeRow } from "@enduragent/ui";
import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerItem,
} from "@enduragent/coach-contract";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
} from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

function useAttachmentFormatting() {
  const { say, format } = usePhrasebook();
  const number = (value: number) => format.number(value, { useGrouping: false });
  const decimal = (value: number) =>
    format.number(Number(value.toFixed(1)), {
      useGrouping: false,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  return {
    bytes: (value: number) =>
      value >= 1_048_576
        ? say("chat.attachment.megabytes", { number: decimal(value / 1_048_576) })
        : say("chat.attachment.kilobytes", {
            number: number(Math.max(1, Math.round(value / 1_024))),
          }),
    duration(seconds: number) {
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return say("chat.attachment.minutes", { number: number(minutes) });
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      return remainder === 0
        ? say("chat.attachment.hours", { number: number(hours) })
        : say("chat.attachment.hoursMinutes", { hours: number(hours), minutes: number(remainder) });
    },
    distance: (meters: number | null) =>
      meters === null
        ? "—"
        : say("chat.attachment.kilometers", { number: decimal(meters / 1_000) }),
    date: (seconds: number) =>
      format.date(new Date(seconds * 1_000), { day: "numeric", month: "short" }),
  };
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

function ReadyPreview(props: { readonly attachment: ChatAttachmentComposerItem }): ReactElement {
  const { say, format } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const { duration, distance, date } = useAttachmentFormatting();
  const planningRequestsLoaded = useEnduragentStore((state) => state.chat.planningRequestsLoaded);
  const planningRequestBusyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  const attachment = props.attachment;
  if (attachment.status !== "ready") throw new TypeError("attachment is not ready");
  if (attachment.preview.kind === "document") {
    const scanned = attachment.preview.extractedTextChars === 0;
    return (
      <NoticeRow
        title={scanned ? say("chat.attachment.storedScanned") : say("chat.attachment.stored")}
      >
        {scanned ? say("chat.attachment.scannedDetail") : say("chat.attachment.documentDetail")}
      </NoticeRow>
    );
  }
  if (attachment.preview.kind === "activity") {
    const session = attachment.preview.sessions[0]!;
    return (
      <>
        <EvidenceList
          className="border-t border-line"
          label={say("chat.attachment.activity")}
          rows={[
            { id: "date", label: say("chat.attachment.date"), value: date(session.startUtc) },
            {
              id: "duration",
              label: say("chat.attachment.duration"),
              value: duration(session.durationSeconds),
            },
            {
              id: "distance",
              label: say("chat.attachment.distance"),
              value: distance(session.distanceMeters),
            },
          ]}
        />
        <NoticeRow tone="neutral" title={say("chat.attachment.importTitle")}>
          {say("chat.attachment.importDetail")}
        </NoticeRow>
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
          <legend className="px-2 py-1 text-xs text-ink-2">
            {say("chat.attachment.selectWorkout")}
          </legend>
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
          <NoticeRow
            title={say("chat.attachment.selected", { title: selected.title })}
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
                {planningRequestBusyId === null
                  ? say("chat.attachment.review")
                  : say("chat.attachment.opening")}
              </Button>
            }
          >
            {say("chat.attachment.workoutDetail")}
          </NoticeRow>
        )}
      </>
    );
  }
  return (
    <NoticeRow title={say("chat.attachment.imageTitle")}>
      {say("chat.attachment.imageDetail", {
        width: format.number(attachment.preview.width, { useGrouping: false }),
        height: format.number(attachment.preview.height, { useGrouping: false }),
      })}
    </NoticeRow>
  );
}

function AttachmentCard(props: { readonly attachment: ChatAttachmentComposerItem }): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const { bytes } = useAttachmentFormatting();
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const attachment = props.attachment;
  return (
    <AttachmentPreview
      aria-label={say("chat.attachment.label", { name: attachment.displayName })}
      title={attachment.displayName}
      detail={
        <>
          {attachment.extension.toUpperCase()} · {bytes(attachment.byteSize)}
          {attachment.status === "preprocessing" ? say("chat.attachment.processingSuffix") : ""}
        </>
      }
      icon={<AttachmentIcon kind={attachment.kind} />}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            actions?.removeAttachment(attachment.attachmentId);
          }}
        >
          {say("chat.attachment.remove")}
        </Button>
      }
    >
      {attachment.status === "preprocessing" ? (
        <NoticeRow title={say("chat.attachment.processingTitle")}>
          {say("chat.attachment.processingDetail")}
        </NoticeRow>
      ) : null}
      {attachment.status === "blocked" ? (
        <NoticeRow
          tone="warning"
          title={
            attachment.reason === "encrypted_pdf"
              ? say("chat.attachment.encryptedTitle")
              : say("chat.attachment.incompatibleTitle")
          }
          action={
            attachment.reason === "encrypted_pdf" ? undefined : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setActiveView("settings")}
              >
                {say("chat.attachment.settings")}
              </Button>
            )
          }
        >
          {attachment.reason === "encrypted_pdf"
            ? say("chat.attachment.encryptedDetail")
            : say("chat.attachment.incompatibleDetail")}
        </NoticeRow>
      ) : null}
      {attachment.status === "failed" ? (
        <NoticeRow
          tone="warning"
          title={say("chat.attachment.failedTitle")}
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
                {say("chat.attachment.retry")}
              </Button>
            ) : undefined
          }
        >
          {say("chat.attachment.failedDetail")}
        </NoticeRow>
      ) : null}
      {attachment.status === "ready" ? <ReadyPreview attachment={attachment} /> : null}
    </AttachmentPreview>
  );
}

function AdmissionFailure(props: {
  readonly admission: AttachmentAdmissionReadModel;
}): ReactElement | null {
  const { say } = usePhrasebook();
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
            {unsupported
              ? say("chat.attachment.unknownFormat")
              : say("chat.attachment.admissionFailed")}
          </small>
        </div>
      </div>
      <div>
        <strong className="block text-sm text-ink">
          {unsupported ? say("chat.attachment.unsupportedTitle") : say("chat.attachment.safeDraft")}
        </strong>
        <p className="mt-1 mb-0 text-xs leading-5 text-ink-2">
          {unsupported
            ? say("chat.attachment.formats", {
                formats: "FIT, TCX, GPX, ZWO, ERG, MRC, PDF, TXT, CSV, DOCX, PNG, JPG",
                finalFormat: "WEBP",
              })
            : say("chat.attachment.chooseAgain")}
        </p>
      </div>
      <div className="flex gap-2 max-[760px]:justify-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void actions?.chooseAttachments()}
        >
          {say("chat.attachment.chooseFile")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => actions?.receiveAttachmentAdmissions([])}
        >
          {say("chat.attachment.dismiss")}
        </Button>
      </div>
    </section>
  );
}

export function AttachmentPanel(): ReactElement | null {
  const { say } = usePhrasebook();
  const surface = useEnduragentStore((state) => state.chat);
  const actions = useEnduragentStore((state) => state.chatActions);
  const attachmentError =
    surface.attachmentError === null ? null : chatFeedbackMessage(surface.attachmentError);
  const planningRequestError =
    surface.planningRequestError === null
      ? null
      : chatFeedbackMessage(surface.planningRequestError);
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
    <AttachmentList aria-live="polite">
      {surface.attachmentBusy ? (
        <div className="flex items-center gap-3 rounded-card border border-line-2 bg-surface p-4 text-sm text-ink-2">
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {say("chat.attachment.adding")}
        </div>
      ) : null}
      {surface.attachmentError === null ? null : (
        <div
          className="rounded-card border border-danger/40 bg-surface p-4 text-sm text-danger"
          role="alert"
        >
          {attachmentError === null ? surface.attachmentError : say(attachmentError)}
        </div>
      )}
      {surface.planningRequestError === null ? null : (
        <div
          className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-surface p-4 text-sm text-danger"
          role="alert"
        >
          <span>
            {planningRequestError === null
              ? surface.planningRequestError
              : say(planningRequestError)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={surface.planningRequestBusyId !== null}
            onClick={() => actions?.retryPlanningRequestLoad()}
          >
            {say("chat.attachment.retry")}
          </Button>
        </div>
      )}
      {surface.attachmentAdmissions.map((admission) => (
        <AdmissionFailure key={admission.selectionId} admission={admission} />
      ))}
      {attachments.map((attachment) => (
        <AttachmentCard key={attachment.attachmentId} attachment={attachment} />
      ))}
    </AttachmentList>
  );
}
