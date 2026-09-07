import { useEffect, useRef, type ReactElement } from "react";
import type { ArchiveReadingState } from "../../archive/controller";
import type { TranscriptTurn } from "../../chat/hydration";
import { Button } from "@enduragent/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { AthleteMessage } from "../chat/AthleteMessage";
import { CoachMessage } from "../chat/CoachMessage";
import { Page } from "@enduragent/ui";
import {
  ARCHIVE_BACK_COPY,
  ARCHIVE_DELETE_COPY,
  ARCHIVE_DELETE_DESCRIPTION,
  ARCHIVE_DELETE_FAILURE_COPY,
  ARCHIVE_DELETE_TITLE,
  ARCHIVE_EMPTY_CONVERSATION_COPY,
  ARCHIVE_EMPTY_COPY,
  ARCHIVE_LIST_FAILURE_COPY,
  ARCHIVE_LOADING_COPY,
  ARCHIVE_LOAD_EARLIER_COPY,
  ARCHIVE_PAGE_FAILURE_COPY,
  ARCHIVE_READ_ONLY_NOTE,
  ARCHIVE_RETRY_COPY,
  ARCHIVE_TITLE,
  ARCHIVE_TRUNCATED_COPY,
  ARCHIVE_UNAVAILABLE_COPY,
  archiveReasonCopy,
  archiveTimestampCopy,
  archiveTurnCountCopy,
} from "./copy";

const NOTE_CLASS = "mb-3.5 text-sm text-ink-2";
const ACTION_CLASS = "justify-self-start [&[hidden]]:hidden";

function TurnRows(props: {
  readonly turn: TranscriptTurn;
  readonly includeAthlete: boolean;
}): ReactElement {
  return (
    <>
      {props.includeAthlete ? (
        <article
          className="archive-message archive-message--athlete grid min-w-0 max-w-[78%] justify-self-end gap-[7px] rounded-card rounded-br-ctl border border-line bg-surface px-4 py-3 shadow-elev-1"
          data-turn-id={props.turn.turnId}
        >
          <p className="m-0 text-xs font-medium text-ink-3">You</p>
          <AthleteMessage text={props.turn.athleteText} />
        </article>
      ) : null}
      <article
        className="archive-message archive-message--coach grid min-w-0 max-w-[78%] justify-self-start gap-[7px] font-[var(--f-prose)] text-base leading-[1.6] tracking-[0.002em]"
        data-turn-id={props.turn.turnId}
        data-delivery={props.turn.delivery ?? "complete"}
      >
        <p className="m-0 text-xs font-medium text-ink-3">Coach</p>
        <CoachMessage text={props.turn.coachText} />
      </article>
    </>
  );
}

function ArchiveList(): ReactElement {
  const listStatus = useEnduragentStore((state) => state.archive.listStatus);
  const conversations = useEnduragentStore((state) => state.archive.conversations);
  const truncated = useEnduragentStore((state) => state.archive.truncated);
  const actions = useEnduragentStore((state) => state.archiveActions);
  const failed = listStatus === "failed";

  return (
    <>
      <p className={`${NOTE_CLASS} archive-note`}>{ARCHIVE_READ_ONLY_NOTE}</p>
      <p
        className={`${NOTE_CLASS} archive-status`}
        role="status"
        aria-live="polite"
        hidden={listStatus === "ready"}
      >
        {failed ? ARCHIVE_LIST_FAILURE_COPY : ARCHIVE_LOADING_COPY}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${ACTION_CLASS} archive-retry`}
        hidden={!failed}
        disabled={actions === null}
        onClick={() => {
          if (!failed) return;
          actions?.retry();
        }}
      >
        {ARCHIVE_RETRY_COPY}
      </Button>
      <p
        className={`${NOTE_CLASS} archive-empty`}
        hidden={listStatus !== "ready" || conversations.length > 0}
      >
        {ARCHIVE_EMPTY_COPY}
      </p>
      <div className="archive-list grid gap-inset">
        {conversations.map((entry) => (
          <Button
            key={entry.boundaryRef}
            type="button"
            variant="outline"
            className="archive-entry grid h-auto w-full grid-cols-1 items-start justify-start justify-items-start gap-1 whitespace-normal rounded-card border-line bg-surface px-3.5 py-3 text-left font-normal shadow-elev-1 transition-colors hover:border-line-2 hover:bg-surface-2 active:shadow-none"
            aria-label={`${archiveTimestampCopy(entry.boundaryAt)} · ${archiveTurnCountCopy(entry.turnCount)} · ${archiveReasonCopy(entry.reason)}`}
            disabled={actions === null}
            onClick={() => {
              actions?.open(entry.boundaryRef);
            }}
          >
            <span className="text-xs leading-4 font-medium tracking-normal">
              {archiveTimestampCopy(entry.boundaryAt)}
            </span>
            <span className="text-xs text-ink-2">
              {archiveTurnCountCopy(entry.turnCount)} · {archiveReasonCopy(entry.reason)}
            </span>
          </Button>
        ))}
      </div>
      <p className={`${NOTE_CLASS} archive-truncated`} hidden={!truncated}>
        {ARCHIVE_TRUNCATED_COPY}
      </p>
    </>
  );
}

function ArchiveReader(props: { readonly reading: ArchiveReadingState }): ReactElement {
  const actions = useEnduragentStore((state) => state.archiveActions);
  const deletion = useEnduragentStore((state) => state.archive.deletion);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const reading = props.reading;
  const failed = reading.status === "failed";
  const unavailable = reading.status === "unavailable";
  const deleteOpen = deletion?.boundaryRef === reading.boundaryRef;
  const deletePending = deleteOpen && deletion.status === "deleting";
  const deleteFailed = deleteOpen && deletion.status === "failed";
  const attempts = new Map<string, number>();
  const projectedTurns = reading.turns.map((turn) => {
    const attempt = (attempts.get(turn.turnId) ?? 0) + 1;
    attempts.set(turn.turnId, attempt);
    return { turn, attempt };
  });

  return (
    <>
      <div className="mb-4 hidden items-center gap-inset has-[>*:not([hidden])]:flex">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`${ACTION_CLASS} archive-back`}
          disabled={actions === null}
          onClick={() => {
            actions?.close();
          }}
        >
          {ARCHIVE_BACK_COPY}
        </Button>
        <p className={`${NOTE_CLASS} archive-reading-when mb-0`}>
          {reading.boundaryAt === null ? "" : archiveTimestampCopy(reading.boundaryAt)}
        </p>
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (open) actions?.requestDeletion(reading.boundaryRef);
            else if (!deletePending) actions?.cancelDeletion();
          }}
        >
          <DialogTrigger
            render={
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="archive-delete ml-auto"
                disabled={actions === null}
              />
            }
          >
            {ARCHIVE_DELETE_COPY}
          </DialogTrigger>
          <DialogContent
            className="archive-delete-dialog w-[min(460px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
            showCloseButton={false}
            initialFocus={cancelDelete}
            aria-busy={deletePending ? "true" : undefined}
          >
            <DialogHeader className="gap-2.5">
              <DialogTitle className="m-0 text-xl">{ARCHIVE_DELETE_TITLE}</DialogTitle>
              <DialogDescription className="m-0 leading-[1.5]">
                {ARCHIVE_DELETE_DESCRIPTION}
                {deleteFailed ? (
                  <span className="mt-2 block text-destructive" role="alert">
                    {ARCHIVE_DELETE_FAILURE_COPY}
                  </span>
                ) : null}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
              <DialogClose
                render={
                  <Button
                    ref={cancelDelete}
                    type="button"
                    variant="outline"
                    size="lg"
                    disabled={deletePending}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                variant="destructive-solid"
                size="lg"
                disabled={deletePending}
                onClick={() => {
                  actions?.confirmDeletion();
                }}
              >
                {deleteFailed ? ARCHIVE_RETRY_COPY : ARCHIVE_DELETE_COPY}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <p className={`${NOTE_CLASS} archive-note`}>{ARCHIVE_READ_ONLY_NOTE}</p>
      <p
        className={`${NOTE_CLASS} archive-reading-status`}
        role="status"
        aria-live="polite"
        hidden={reading.status === "ready"}
      >
        {failed
          ? ARCHIVE_PAGE_FAILURE_COPY
          : unavailable
            ? ARCHIVE_UNAVAILABLE_COPY
            : ARCHIVE_LOADING_COPY}
      </p>
      <div className="mb-4 hidden items-center gap-inset has-[>*:not([hidden])]:flex">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`${ACTION_CLASS} archive-load-earlier`}
          hidden={!reading.hasEarlier || failed}
          disabled={actions === null || reading.status === "loading"}
          onClick={() => {
            if (!reading.hasEarlier) return;
            actions?.loadEarlier();
          }}
        >
          {ARCHIVE_LOAD_EARLIER_COPY}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`${ACTION_CLASS} archive-retry`}
          hidden={!failed}
          disabled={actions === null}
          onClick={() => {
            if (!failed) return;
            actions?.retry();
          }}
        >
          {ARCHIVE_RETRY_COPY}
        </Button>
      </div>
      <p
        className={`${NOTE_CLASS} archive-empty`}
        hidden={reading.status !== "ready" || reading.turns.length > 0}
      >
        {ARCHIVE_EMPTY_CONVERSATION_COPY}
      </p>
      <section className="archive-thread grid gap-6" aria-label="Past conversation" aria-live="off">
        {projectedTurns.map(({ turn, attempt }) => (
          <TurnRows
            key={`${turn.turnId}:attempt:${attempt}`}
            turn={turn}
            includeAthlete={attempt === 1}
          />
        ))}
      </section>
    </>
  );
}

export function ArchiveView(): ReactElement {
  const listStatus = useEnduragentStore((state) => state.archive.listStatus);
  const reading = useEnduragentStore((state) => state.archive.reading);
  const actions = useEnduragentStore((state) => state.archiveActions);

  useEffect(() => {
    actions?.refresh();
  }, [actions]);

  return (
    <Page
      title={ARCHIVE_TITLE}
      busy={listStatus === "loading" || reading?.status === "loading"}
      className="archive-view"
    >
      {reading === null ? <ArchiveList /> : <ArchiveReader reading={reading} />}
    </Page>
  );
}
