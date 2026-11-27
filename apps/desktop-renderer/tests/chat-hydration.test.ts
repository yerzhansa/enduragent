import { describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_HYDRATION_PAGE_LIMIT,
  createTranscriptHydrator,
  mergeHydratedMessages,
  type TranscriptHydrationSnapshot,
  type TranscriptPage,
  type TranscriptTurn,
} from "../src/chat/hydration";
import type { ChatTranscriptMessage } from "../src/turn-state";

function turn(turnId: string): TranscriptTurn {
  return {
    turnId,
    completedAt: "2001-01-01T00:00:00.000Z",
    athleteText: `Athlete ${turnId}`,
    coachText: `Coach ${turnId}`,
  };
}

function page(turns: readonly TranscriptTurn[], nextCursor: string | null): TranscriptPage {
  return { schemaVersion: 1, status: "page", turns, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function subject(
  readPage: (request: { cursor: string | null; limit: number }) => Promise<TranscriptPage>,
) {
  const snapshots: TranscriptHydrationSnapshot[] = [];
  const hydrator = createTranscriptHydrator({
    readPage,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { hydrator, snapshots };
}

describe("chat transcript hydration", () => {
  it("hydrates v2 decision entries as the original athlete message and completed Coach response", async () => {
    const decision = {
      decisionId: "decision-1",
      chatId: "desktop",
      messageId: "message-1",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };
    const { hydrator, snapshots } = subject(async () => ({
      schemaVersion: 2,
      status: "page",
      turns: [],
      entries: [
        {
          kind: "decision-requested",
          recordedAt: "2001-01-01T00:00:00.000Z",
          athleteText: "What should I do tomorrow?",
          decision,
        },
        {
          kind: "decision-answered",
          recordedAt: "2001-01-01T00:01:00.000Z",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "recovery" },
          consequence: "Tomorrow becomes a recovery day.",
          continuationId: "continuation-1",
        },
        {
          kind: "decision-continuation-completed",
          recordedAt: "2001-01-01T00:02:00.000Z",
          completedAt: "2001-01-01T00:02:00.000Z",
          decisionId: "decision-1",
          continuationId: "continuation-1",
          turnId: "turn-1",
          coachText: "We’ll keep tomorrow easy.",
        },
      ],
      nextCursor: null,
    }));

    await hydrator.start();
    const snapshot = snapshots.at(-1)!;
    expect(snapshot.entries).toHaveLength(3);
    expect(mergeHydratedMessages(snapshot.turns, [], snapshot.entries)).toMatchObject([
      { role: "athlete", text: "What should I do tomorrow?", historical: true },
      { role: "coach", text: "We’ll keep tomorrow easy.", historical: true },
    ]);
  });

  it("loads the newest bounded page and exposes only its backward cursor", async () => {
    const readPage = vi.fn(async () => page([turn("turn-3"), turn("turn-4")], "older"));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();

    expect(readPage).toHaveBeenCalledWith({
      cursor: null,
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-3" }, { turnId: "turn-4" }],
      nextCursor: "older",
      revision: 1,
      change: "initial",
    });
  });

  it("prepends one explicit page at a time without replacing stable newer turns", async () => {
    const newest = [turn("turn-3"), turn("turn-4")];
    const earlier = [turn("turn-1"), turn("turn-2")];
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page(newest, "older"))
      .mockResolvedValueOnce(page(earlier, null));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    const newerReferences = snapshots.at(-1)!.turns;
    await hydrator.loadEarlier();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toEqual({
      cursor: "older",
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    expect(snapshots.at(-1)?.turns.map(({ turnId }) => turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-4",
    ]);
    expect(snapshots.at(-1)?.turns[2]).toBe(newerReferences[0]);
    expect(snapshots.at(-1)?.turns[3]).toBe(newerReferences[1]);
    expect(snapshots.at(-1)).toMatchObject({ nextCursor: null, change: "prepend" });
  });

  it("deduplicates exact records across overlapping pages without collapsing retry attempts", async () => {
    const interrupted = {
      ...turn("turn-recovered"),
      coachText: "Partial",
      delivery: "interrupted" as const,
    };
    const recovered = {
      ...turn("turn-recovered"),
      completedAt: "2001-01-01T00:01:00.000Z",
      coachText: "Recovered",
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([recovered, turn("turn-later")], "older"))
      .mockResolvedValueOnce(page([interrupted, recovered], null));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    await hydrator.loadEarlier();

    expect(snapshots.at(-1)?.turns.map(({ turnId, coachText }) => [turnId, coachText])).toEqual([
      ["turn-recovered", "Partial"],
      ["turn-recovered", "Recovered"],
      ["turn-later", "Coach turn-later"],
    ]);
  });

  it("deduplicates a hydrated turn against live rows by turn identity", () => {
    const live: readonly ChatTranscriptMessage[] = [
      {
        id: "message-1",
        turnId: "turn-2",
        role: "athlete",
        text: "Live athlete",
        delivery: "complete",
      },
      {
        id: "message-2",
        turnId: "turn-2",
        role: "coach",
        text: "Live coach",
        delivery: "complete",
      },
    ];

    const merged = mergeHydratedMessages([turn("turn-1"), turn("turn-2")], live);

    expect(merged.map(({ id }) => id)).toEqual([
      "history:athlete:turn-1",
      "history:coach:turn-1",
      "message-1",
      "message-2",
    ]);
    expect(merged.slice(2)).toEqual(live);
  });

  it("restores an interrupted coach response after relaunch", () => {
    const interrupted = { ...turn("turn-stopped"), delivery: "interrupted" as const };

    expect(mergeHydratedMessages([interrupted], [])).toEqual([
      {
        id: "history:athlete:turn-stopped",
        turnId: "turn-stopped",
        role: "athlete",
        text: "Athlete turn-stopped",
        delivery: "complete",
        historical: true,
      },
      {
        id: "history:coach:turn-stopped",
        turnId: "turn-stopped",
        role: "coach",
        text: "Coach turn-stopped",
        delivery: "interrupted",
        historical: true,
      },
    ]);
  });

  it("relaunches a recovered durable turn with one athlete row and every Coach attempt", async () => {
    const interrupted = {
      ...turn("turn-recovered"),
      athleteText: "First",
      coachText: "Partial",
      delivery: "interrupted" as const,
    };
    const recovered = {
      ...turn("turn-recovered"),
      completedAt: "2001-01-01T00:01:00.000Z",
      athleteText: "First",
      coachText: "Recovered",
    };
    const later = {
      ...turn("turn-later"),
      completedAt: "2001-01-01T00:02:00.000Z",
      athleteText: "Later one\n\nLater two",
      coachText: "Later reply",
    };
    const { hydrator, snapshots } = subject(async () =>
      page([interrupted, recovered, later], null),
    );

    await hydrator.start();

    expect(mergeHydratedMessages(snapshots.at(-1)!.turns, [])).toMatchObject([
      { role: "athlete", text: "First", delivery: "complete" },
      { role: "coach", text: "Partial", delivery: "interrupted" },
      { role: "coach", text: "Recovered", delivery: "complete" },
      { role: "athlete", text: "Later one\n\nLater two", delivery: "complete" },
      { role: "coach", text: "Later reply", delivery: "complete" },
    ]);
  });

  it("projects schema-v2 retry entries with one athlete row and unique Coach rows", async () => {
    const interrupted = {
      kind: "turn" as const,
      ...turn("turn-recovered-v2"),
      athleteText: "First",
      coachText: "Partial",
      delivery: "interrupted" as const,
    };
    const recovered = {
      kind: "turn" as const,
      ...turn("turn-recovered-v2"),
      completedAt: "2001-01-01T00:01:00.000Z",
      athleteText: "First",
      coachText: "Recovered",
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        status: "page",
        turns: [recovered],
        entries: [recovered],
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        status: "page",
        turns: [interrupted, recovered],
        entries: [interrupted, recovered],
        nextCursor: null,
      });
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    await hydrator.loadEarlier();

    expect(
      mergeHydratedMessages(snapshots.at(-1)!.turns, [], snapshots.at(-1)!.entries).map(
        ({ id, role, text, delivery }) => ({ id, role, text, delivery }),
      ),
    ).toEqual([
      {
        id: "history:athlete:turn-recovered-v2",
        role: "athlete",
        text: "First",
        delivery: "complete",
      },
      {
        id: "history:coach:turn-recovered-v2",
        role: "coach",
        text: "Partial",
        delivery: "interrupted",
      },
      {
        id: "history:coach:turn-recovered-v2:attempt:2",
        role: "coach",
        text: "Recovered",
        delivery: "complete",
      },
    ]);
  });

  it("does not restore an empty athlete row for an interrupted decision continuation", () => {
    const interrupted = {
      ...turn("turn-decision-stopped"),
      athleteText: "",
      delivery: "interrupted" as const,
    };

    expect(mergeHydratedMessages([interrupted], [])).toEqual([
      {
        id: "history:coach:turn-decision-stopped",
        turnId: "turn-decision-stopped",
        role: "coach",
        text: "Coach turn-decision-stopped",
        delivery: "interrupted",
        historical: true,
      },
    ]);
  });

  it("preserves newer schema-v1 retry turns after an older schema-v2 page loads", async () => {
    const interrupted = {
      ...turn("turn-recovered-mixed"),
      athleteText: "First",
      coachText: "Partial",
      delivery: "interrupted" as const,
    };
    const recovered = {
      ...turn("turn-recovered-mixed"),
      completedAt: "2001-01-01T00:01:00.000Z",
      athleteText: "First",
      coachText: "Recovered",
    };
    const later = {
      ...turn("turn-later-mixed"),
      completedAt: "2001-01-01T00:02:00.000Z",
      athleteText: "Later one\n\nLater two",
      coachText: "Later reply",
    };
    const older = {
      kind: "turn" as const,
      ...turn("turn-older-mixed"),
      athleteText: "Older",
      coachText: "Older reply",
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([interrupted, recovered, later], "older"))
      .mockResolvedValueOnce({
        schemaVersion: 2,
        status: "page",
        turns: [older],
        entries: [older],
        nextCursor: null,
      });
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    await hydrator.loadEarlier();

    expect(
      mergeHydratedMessages([], [], snapshots.at(-1)!.entries).map(({ role, text, delivery }) => ({
        role,
        text,
        delivery,
      })),
    ).toEqual([
      { role: "athlete", text: "Older", delivery: "complete" },
      { role: "coach", text: "Older reply", delivery: "complete" },
      { role: "athlete", text: "First", delivery: "complete" },
      { role: "coach", text: "Partial", delivery: "interrupted" },
      { role: "coach", text: "Recovered", delivery: "complete" },
      { role: "athlete", text: "Later one\n\nLater two", delivery: "complete" },
      { role: "coach", text: "Later reply", delivery: "complete" },
    ]);
  });

  it("restores sent attachment cards on the athlete message after relaunch", () => {
    const attached = {
      ...turn("turn-attached"),
      attachments: [
        {
          attachmentId: "attachment-1",
          displayName: "training-notes.txt",
          kind: "document" as const,
          extension: "txt" as const,
        },
      ],
    };

    expect(mergeHydratedMessages([attached], [])).toMatchObject([
      {
        id: "history:athlete:turn-attached",
        role: "athlete",
        historical: true,
        attachments: attached.attachments,
      },
      { id: "history:coach:turn-attached", role: "coach", historical: true },
    ]);
  });

  it("clears stale history and restarts from newest once after a reset signal", async () => {
    const recovery = deferred<TranscriptPage>();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([turn("turn-3"), turn("turn-4")], "older"))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: "restart-required",
        turns: [],
        nextCursor: null,
      })
      .mockImplementationOnce(() => recovery.promise);
    const { hydrator, snapshots } = subject(readPage);
    await hydrator.start();

    const loading = hydrator.loadEarlier();
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({
        turns: [],
        status: "loading",
        change: "clear",
      });
    });
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage.mock.calls[2]?.[0]).toMatchObject({ cursor: null });

    recovery.resolve(page([turn("turn-8")], null));
    await loading;

    expect(snapshots.at(-1)).toMatchObject({
      turns: [{ turnId: "turn-8" }],
      status: "ready",
      change: "initial",
    });
  });

  it("does not loop when the one newest-page recovery also requests a restart", async () => {
    const restart: TranscriptPage = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    const readPage = vi.fn(async () => restart);
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });
  });

  it("retries the newest page after reset recovery fails", async () => {
    const restart: TranscriptPage = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([turn("turn-2")], "older"))
      .mockResolvedValueOnce(restart)
      .mockRejectedValueOnce(new Error("internal detail"))
      .mockResolvedValueOnce(page([turn("turn-8")], null));
    const { hydrator, snapshots } = subject(readPage);
    await hydrator.start();

    await hydrator.loadEarlier();
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });

    await hydrator.retry();

    expect(readPage.mock.calls[3]?.[0]).toMatchObject({ cursor: null });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-8" }],
    });
  });

  it("ignores an in-flight page after a successful new-conversation reset", async () => {
    const pending = deferred<TranscriptPage>();
    const { hydrator, snapshots } = subject(() => pending.promise);
    const loading = hydrator.start();

    hydrator.beginReset();
    hydrator.resetSucceeded();
    pending.resolve(page([turn("turn-stale")], null));
    await loading;

    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [],
      change: "clear",
    });
    expect(snapshots.some((snapshot) => snapshot.turns[0]?.turnId === "turn-stale")).toBe(false);
  });

  it("keeps failures non-fatal and retries only the failed page", async () => {
    const readPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("internal detail"))
      .mockResolvedValueOnce(page([turn("turn-1")], null));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });

    await hydrator.retry();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toMatchObject({ cursor: null });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-1" }],
    });
  });

  it("keeps v2 entry-only history ready on beginReset and retries the earlier cursor after reset failure", async () => {
    const decision = {
      decisionId: "decision-v2",
      chatId: "desktop",
      messageId: "message-v2",
      question: "Choose tomorrow’s focus.",
      status: "unanswered" as const,
      options: [
        {
          id: "easy",
          label: "Easy spin",
          description: "Keep it light.",
          recommended: true,
          consequence: "Tomorrow becomes an easy spin.",
        },
      ],
    };
    const earlierPending = deferred<TranscriptPage>();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        status: "page",
        turns: [],
        entries: [
          {
            kind: "decision-requested",
            recordedAt: "1998-03-04T08:00:00.000Z",
            athleteText: "How should I ride tomorrow?",
            decision,
          },
          {
            kind: "decision-answered",
            recordedAt: "1998-03-04T08:01:00.000Z",
            decisionId: "decision-v2",
            answer: { kind: "option", optionId: "easy" },
            consequence: "Tomorrow becomes an easy spin.",
            continuationId: "continuation-v2",
          },
          {
            kind: "decision-continuation-completed",
            recordedAt: "1998-03-04T08:02:00.000Z",
            completedAt: "1998-03-04T08:02:00.000Z",
            decisionId: "decision-v2",
            continuationId: "continuation-v2",
            turnId: "turn-v2",
            coachText: "Keep tomorrow easy.",
          },
        ],
        nextCursor: "older-v2",
      } satisfies TranscriptPage)
      .mockImplementationOnce(() => earlierPending.promise)
      .mockResolvedValueOnce({
        schemaVersion: 2,
        status: "page",
        turns: [turn("turn-older")],
        entries: [
          {
            kind: "turn",
            ...turn("turn-older"),
            completedAt: "1998-03-03T08:00:00.000Z",
          },
        ],
        nextCursor: null,
      } satisfies TranscriptPage);
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    const loadingEarlier = hydrator.loadEarlier();
    hydrator.beginReset();

    expect(snapshots.at(-1)?.status).toBe("ready");

    hydrator.resetFailed();
    expect(snapshots.at(-1)?.status).toBe("failed");

    await hydrator.retry();
    earlierPending.resolve(page([], null));
    await loadingEarlier;

    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage.mock.calls[2]?.[0]).toEqual({
      cursor: "older-v2",
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    expect(snapshots.at(-1)?.entries).toHaveLength(4);
  });
});
