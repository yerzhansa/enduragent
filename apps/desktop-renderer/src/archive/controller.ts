import type { TranscriptPage, TranscriptTurn } from "../chat/hydration";

export const ARCHIVE_PAGE_LIMIT = 25;

export interface ArchivedConversationEntry {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: "explicit-reset" | "stale-reset";
  readonly turnCount: number;
}

export interface ArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: readonly ArchivedConversationEntry[];
  readonly truncated: boolean;
}

export type ArchiveListStatus = "idle" | "loading" | "ready" | "failed";
export type ArchiveReadingStatus = "loading" | "ready" | "failed" | "unavailable";
export type ArchiveDeletionStatus = "confirming" | "deleting" | "failed";

export interface ArchiveReadingState {
  readonly boundaryRef: string;
  readonly boundaryAt: string | null;
  readonly status: ArchiveReadingStatus;
  readonly turns: readonly TranscriptTurn[];
  readonly hasEarlier: boolean;
}

export interface ArchiveDeletionState {
  readonly boundaryRef: string;
  readonly status: ArchiveDeletionStatus;
}

export interface DeleteArchivedConversationResult {
  readonly schemaVersion: 1;
  readonly status: "deleted" | "not-found";
}

export interface ArchiveViewState {
  readonly listStatus: ArchiveListStatus;
  readonly conversations: readonly ArchivedConversationEntry[];
  readonly truncated: boolean;
  readonly reading: ArchiveReadingState | null;
  readonly deletion: ArchiveDeletionState | null;
}

export interface ArchiveView {
  render(state: ArchiveViewState): void;
}

export interface ArchiveController {
  refresh(): Promise<void>;
  open(boundaryRef: string): Promise<void>;
  close(): void;
  loadEarlier(): Promise<void>;
  retry(): Promise<void>;
  requestDeletion(boundaryRef: string): void;
  cancelDeletion(): void;
  confirmDeletion(): Promise<void>;
  dispose(): void;
}

export const EMPTY_ARCHIVE_SURFACE: ArchiveViewState = Object.freeze({
  listStatus: "idle",
  conversations: Object.freeze([]),
  truncated: false,
  reading: null,
  deletion: null,
});

function uniqueTurns(
  incoming: readonly TranscriptTurn[],
  existing: readonly TranscriptTurn[],
): readonly TranscriptTurn[] {
  const seen = new Set(existing.map((turn) => JSON.stringify(turn)));
  return incoming.filter((turn) => {
    const key = JSON.stringify(turn);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createArchiveController(input: {
  readonly listConversations: () => Promise<ArchivedConversationList>;
  readonly readPage: (request: {
    readonly boundaryRef: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly deleteConversation: (boundaryRef: string) => Promise<DeleteArchivedConversationResult>;
  readonly view: ArchiveView;
}): ArchiveController {
  let state = EMPTY_ARCHIVE_SURFACE;
  let disposed = false;
  let readerEpoch = 0;
  let listEpoch = 0;
  let listTask: Promise<void> | undefined;
  let pageTask: Promise<void> | undefined;
  let deletionTask: Promise<void> | undefined;
  let nextCursor: string | null = null;
  let failedCursor: string | null | undefined;

  const publish = (next: ArchiveViewState): void => {
    state = next;
    try {
      input.view.render(state);
    } catch {}
  };
  const publishReading = (reading: ArchiveReadingState): void => {
    publish({ ...state, reading });
  };

  const loadList = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (listTask !== undefined) return listTask;
    const requestEpoch = listEpoch;
    publish({ ...state, listStatus: "loading" });
    const pending = (async () => {
      try {
        const listed = await input.listConversations();
        if (disposed || listEpoch !== requestEpoch) return;
        publish({
          ...state,
          listStatus: "ready",
          conversations: listed.conversations,
          truncated: listed.truncated,
        });
      } catch {
        if (!disposed && listEpoch === requestEpoch) {
          publish({ ...state, listStatus: "failed" });
        }
      }
    })();
    listTask = pending;
    void pending.finally(() => {
      if (listTask === pending) listTask = undefined;
    });
    return pending;
  };

  const loadPage = (boundaryRef: string, cursor: string | null): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pageTask !== undefined) return pageTask;
    const requestEpoch = readerEpoch;
    const reading = state.reading;
    if (reading === null || reading.boundaryRef !== boundaryRef) return Promise.resolve();
    publishReading({ ...reading, status: "loading" });
    const pending = (async () => {
      try {
        const page = await input.readPage({ boundaryRef, cursor, limit: ARCHIVE_PAGE_LIMIT });
        if (disposed || readerEpoch !== requestEpoch) return;
        const current = state.reading;
        if (current === null || current.boundaryRef !== boundaryRef) return;
        if (page.status === "restart-required") {
          failedCursor = undefined;
          nextCursor = null;
          publishReading({
            ...current,
            status: "unavailable",
            turns: [],
            hasEarlier: false,
          });
          return;
        }
        failedCursor = undefined;
        nextCursor = page.nextCursor;
        publishReading({
          ...current,
          status: "ready",
          turns:
            cursor === null
              ? uniqueTurns(page.turns, [])
              : [...uniqueTurns(page.turns, current.turns), ...current.turns],
          hasEarlier: page.nextCursor !== null,
        });
      } catch {
        if (disposed || readerEpoch !== requestEpoch) return;
        const current = state.reading;
        if (current === null || current.boundaryRef !== boundaryRef) return;
        failedCursor = cursor;
        publishReading({ ...current, status: "failed" });
      }
    })();
    pageTask = pending;
    void pending.finally(() => {
      if (pageTask === pending) pageTask = undefined;
    });
    return pending;
  };

  publish(state);
  return {
    refresh() {
      return loadList();
    },
    open(boundaryRef) {
      if (disposed || state.deletion?.status === "deleting") return Promise.resolve();
      readerEpoch += 1;
      pageTask = undefined;
      nextCursor = null;
      failedCursor = undefined;
      const entry = state.conversations.find((value) => value.boundaryRef === boundaryRef);
      publish({
        ...state,
        deletion: null,
        reading: {
          boundaryRef,
          boundaryAt: entry?.boundaryAt ?? null,
          status: "loading",
          turns: [],
          hasEarlier: false,
        },
      });
      return loadPage(boundaryRef, null);
    },
    close() {
      if (disposed || state.reading === null || state.deletion?.status === "deleting") {
        return;
      }
      readerEpoch += 1;
      pageTask = undefined;
      nextCursor = null;
      failedCursor = undefined;
      publish({ ...state, reading: null, deletion: null });
    },
    loadEarlier() {
      const reading = state.reading;
      if (disposed || reading === null || reading.status !== "ready" || nextCursor === null) {
        return Promise.resolve();
      }
      return loadPage(reading.boundaryRef, nextCursor);
    },
    retry() {
      const reading = state.reading;
      if (reading !== null) {
        if (reading.status !== "failed") return Promise.resolve();
        return loadPage(reading.boundaryRef, failedCursor ?? null);
      }
      return state.listStatus === "failed" ? loadList() : Promise.resolve();
    },
    requestDeletion(boundaryRef) {
      if (disposed || deletionTask !== undefined || state.reading?.boundaryRef !== boundaryRef) {
        return;
      }
      publish({ ...state, deletion: { boundaryRef, status: "confirming" } });
    },
    cancelDeletion() {
      if (disposed || state.deletion === null || state.deletion.status === "deleting") return;
      publish({ ...state, deletion: null });
    },
    confirmDeletion() {
      if (disposed) return Promise.resolve();
      if (deletionTask !== undefined) return deletionTask;
      const deletion = state.deletion;
      if (deletion === null || deletion.status === "deleting") return Promise.resolve();
      const boundaryRef = deletion.boundaryRef;
      publish({ ...state, deletion: { boundaryRef, status: "deleting" } });
      const pending = (async () => {
        try {
          await input.deleteConversation(boundaryRef);
          if (disposed || state.deletion?.boundaryRef !== boundaryRef) return;
          readerEpoch += 1;
          pageTask = undefined;
          nextCursor = null;
          failedCursor = undefined;
          listEpoch += 1;
          listTask = undefined;
          publish({
            ...state,
            listStatus: "idle",
            conversations: state.conversations.filter(
              (conversation) => conversation.boundaryRef !== boundaryRef,
            ),
            reading: null,
            deletion: null,
          });
          await loadList();
        } catch {
          if (!disposed && state.deletion?.boundaryRef === boundaryRef) {
            publish({ ...state, deletion: { boundaryRef, status: "failed" } });
          }
        }
      })();
      deletionTask = pending;
      void pending.finally(() => {
        if (deletionTask === pending) deletionTask = undefined;
      });
      return pending;
    },
    dispose() {
      disposed = true;
      readerEpoch += 1;
      listEpoch += 1;
      listTask = undefined;
      pageTask = undefined;
      deletionTask = undefined;
    },
  };
}
