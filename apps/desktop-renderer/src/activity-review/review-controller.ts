import type {
  PlanCalendarRideReview,
  PlanCalendarRpcResult,
  PlanCalendarVerdictExpected,
} from "@enduragent/coach-contract";

export type VerdictAsking = "idle" | "asking" | "failed";

export type NoteSaving = "idle" | "saving" | "saved" | "failed";

export type RideReviewState =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly activityId: string }
  | { readonly kind: "unavailable"; readonly activityId: string }
  | {
      readonly kind: "ready";
      readonly activityId: string;
      readonly review: PlanCalendarRideReview;
      readonly asking: VerdictAsking;
      readonly note: NoteSaving;
    };

export const RIDE_REVIEW_NONE: RideReviewState = Object.freeze({ kind: "none" });

export const VERDICT_POLLS = 100;

export interface RideReviewController {
  show(activityId: string | null): Promise<void>;
  refresh(): Promise<void>;
  writeAgain(): Promise<void>;
  saveNote(text: string): Promise<void>;
  dispose(): void;
}

export interface RideReviewControllerDeps {
  read(activityId: string): Promise<PlanCalendarRpcResult>;
  write(request: {
    readonly activityId: string;
    readonly event: "opens" | "asks-again";
    readonly expected: PlanCalendarVerdictExpected;
  }): Promise<PlanCalendarRpcResult>;
  saveNote(request: {
    readonly activityId: string;
    readonly note: string;
  }): Promise<PlanCalendarRpcResult>;
  later(run: () => void): () => void;
  publish(state: RideReviewState): void;
}

type Ready = Extract<RideReviewState, { kind: "ready" }>;

const NO_TIMER = (): void => undefined;

function expectedOf(review: PlanCalendarRideReview): PlanCalendarVerdictExpected {
  return { state: review.verdict.state, replies: review.replies };
}

function opensWrite(review: PlanCalendarRideReview): boolean {
  const verdict = review.verdict;
  return (
    review.blocked === "none" &&
    (verdict.state === "not-written" ||
      (verdict.state === "failed" && verdict.failedBy === "interrupted"))
  );
}

function opensSettled(review: PlanCalendarRideReview): boolean {
  return review.blocked === "none" || review.blocked === "waiting-for-match";
}

async function settle(
  call: () => Promise<PlanCalendarRpcResult>,
): Promise<PlanCalendarRpcResult | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

export function createRideReviewController(deps: RideReviewControllerDeps): RideReviewController {
  let state: RideReviewState = RIDE_REVIEW_NONE;
  let generation = 0;
  let opened = false;
  let polls = 0;
  let cancelTimer: () => void = NO_TIMER;
  let disposed = false;

  const publish = (next: RideReviewState): void => {
    if (disposed) return;
    state = next;
    deps.publish(next);
  };

  const stopPolling = (): void => {
    cancelTimer();
    cancelTimer = NO_TIMER;
  };

  const current = (activityId: string, mine: number): Ready | null =>
    mine === generation && state.kind === "ready" && state.activityId === activityId ? state : null;

  const shown = (
    activityId: string,
    mine: number,
    review: PlanCalendarRideReview,
    patch: Partial<Pick<Ready, "asking" | "note">> = {},
  ): void => {
    if (mine !== generation) return;
    const before = state.kind === "ready" && state.activityId === activityId ? state : null;
    publish({
      kind: "ready",
      activityId,
      review,
      asking: patch.asking ?? before?.asking ?? "idle",
      note: patch.note ?? before?.note ?? "idle",
    });
    stopPolling();
    if (review.verdict.state !== "writing" || polls >= VERDICT_POLLS) return;
    cancelTimer = deps.later(() => {
      cancelTimer = NO_TIMER;
      polls += 1;
      void reread(activityId, mine);
    });
  };

  const reread = async (activityId: string, mine: number): Promise<void> => {
    const result = await settle(() => deps.read(activityId));
    if (mine !== generation) return;
    if (result?.status !== "review") {
      if (state.kind !== "ready") publish({ kind: "unavailable", activityId });
      return;
    }
    shown(activityId, mine, result.review);
    await open(activityId, mine, result.review);
  };

  const open = async (
    activityId: string,
    mine: number,
    review: PlanCalendarRideReview,
  ): Promise<void> => {
    if (opened || !opensSettled(review)) return;
    opened = true;
    if (!opensWrite(review)) return;
    const result = await settle(() =>
      deps.write({ activityId, event: "opens", expected: expectedOf(review) }),
    );
    if (mine !== generation) return;
    if (result?.status === "review") {
      shown(activityId, mine, result.review);
      return;
    }
    polls = 0;
    await reread(activityId, mine);
  };

  return {
    async show(activityId) {
      generation += 1;
      const mine = generation;
      opened = false;
      polls = 0;
      stopPolling();
      if (activityId === null) {
        publish(RIDE_REVIEW_NONE);
        return;
      }
      publish({ kind: "loading", activityId });
      await reread(activityId, mine);
    },
    async refresh() {
      if (state.kind === "none") return;
      polls = 0;
      await reread(state.activityId, generation);
    },
    async writeAgain() {
      if (state.kind !== "ready" || state.asking === "asking") return;
      const { activityId, review } = state;
      const verdict = review.verdict.state;
      if (review.blocked !== "none" || (verdict !== "kept" && verdict !== "failed")) return;
      const mine = generation;
      stopPolling();
      publish({ ...state, asking: "asking" });
      const result = await settle(() =>
        deps.write({ activityId, event: "asks-again", expected: expectedOf(review) }),
      );
      if (current(activityId, mine) === null) return;
      polls = 0;
      if (result?.status === "review") {
        shown(activityId, mine, result.review, { asking: "idle" });
        return;
      }
      if (result === null) {
        const before = current(activityId, mine);
        if (before !== null) publish({ ...before, asking: "failed" });
        return;
      }
      const ready = current(activityId, mine);
      if (ready !== null) publish({ ...ready, asking: "idle" });
      await reread(activityId, mine);
    },
    async saveNote(text) {
      if (state.kind !== "ready" || state.note === "saving") return;
      const activityId = state.activityId;
      const mine = generation;
      publish({ ...state, note: "saving" });
      const result = await settle(() => deps.saveNote({ activityId, note: text }));
      const ready = current(activityId, mine);
      if (ready === null) return;
      if (result?.status === "review") {
        shown(activityId, mine, result.review, { note: "saved" });
        return;
      }
      publish({ ...ready, note: "failed" });
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopPolling();
    },
  };
}
