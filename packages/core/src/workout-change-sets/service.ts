import { randomBytes, randomUUID } from "node:crypto";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { workoutPhrasebook, workoutProblemKind } from "./copy.js";
import { WorkoutChangeError } from "./error.js";
import type { PendingWorkoutItem, WorkoutPreparationPort } from "@enduragent/engine";
import {
  accountIdentity,
  desired,
  eligible,
  normalizeJson,
  readDay,
  readEvent,
  sameSnapshot,
  snapshot,
  today,
  write,
  type CalendarClient,
} from "./calendar.js";
import {
  preparationSchema,
  type Change,
  type Notice,
  type Payload,
  type Record,
  type Snapshot,
} from "./record.js";
import { renderNotice, renderReview, successes } from "./review.js";
import { digest, openStore } from "./store.js";
import { preparePending } from "./preparation.js";

export interface ReviewDelivery {
  readonly handle: string | null;
  readonly text: string;
}
export interface ArmedControl {
  readonly token: string;
  readonly kind: "approval" | "retry";
  readonly prompt: string;
}
export type Action = {
  readonly kind: "approve" | "retry-remaining" | "cancel";
  readonly token: string;
};
export type Outcome = {
  readonly kind:
    | "completed"
    | "partial"
    | "refresh-required"
    | "uncertain"
    | "blocked"
    | "canceled"
    | "invalid-action";
  readonly text: string;
};
export interface WorkoutChangeSets {
  readonly preparation: WorkoutPreparationPort;
  review(input: {
    readonly chatId: string;
    readonly language: string;
    readonly redisplay?: boolean;
  }): Promise<ReviewDelivery | null>;
  acknowledgeDelivery(input: {
    readonly chatId: string;
    readonly delivery: string;
    readonly language?: string;
  }): Promise<ArmedControl | null>;
  resolve(input: {
    readonly chatId: string;
    readonly action: Action;
    readonly language: string;
  }): Promise<Outcome>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export async function openWorkoutChangeSets(input: {
  readonly dataDir: string;
  readonly client: CalendarClient;
  readonly timezone: string;
}): Promise<WorkoutChangeSets> {
  const account = await accountIdentity(input.client);
  const store = await openStore(input.dataDir, account);
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(() => {
      if (closed) throw new Error("Workout approval service is closed.");
      return action();
    });
    queue = next.catch(() => undefined);
    return next;
  }
  async function verifyAccount(): Promise<void> {
    if ((await accountIdentity(input.client)) !== account)
      throw new WorkoutChangeError(
        "accountChanged",
        "The calendar account changed; this approval cannot be used.",
      );
  }
  async function save(record: Record, state: Record["state"]): Promise<Record> {
    const next = { ...record, state };
    await store.save(next);
    return next;
  }
  function future(date: string): void {
    if (date < today(input.timezone))
      throw new WorkoutChangeError("pastProtected", "Past workout dates are protected.");
  }
  async function contextFor(changes: readonly Change[]): Promise<Snapshot[]> {
    const targets = new Set(
      changes.flatMap((change) => (change.kind === "add" ? [] : [change.reviewed.eventId])),
    );
    const dates = new Set(
      changes.map((change) =>
        change.kind === "add"
          ? change.prepared.date
          : change.kind === "edit"
            ? change.desired.date
            : change.reviewed.date,
      ),
    );
    const context: Snapshot[] = [];
    for (const date of dates) {
      for (const event of await readDay(input.client, date)) {
        if (event.category === "WORKOUT" && !targets.has(event.id)) context.push(snapshot(event));
      }
    }
    return context;
  }
  async function preflight(payload: Payload): Promise<{ payload: Payload; changed: boolean }> {
    await verifyAccount();
    const pending: Change[] = [];
    const differences: { before: Snapshot; after: Snapshot }[] = [];
    for (const change of payload.pending) {
      if (change.kind === "add") {
        future(change.prepared.date);
        pending.push(change);
        continue;
      }
      const event = await readEvent(input.client, change.reviewed.eventId);
      eligible(event, today(input.timezone));
      const current = snapshot(event);
      if (!sameSnapshot(change.reviewed, current))
        differences.push({ before: change.reviewed, after: current });
      if (change.kind === "edit") {
        const next = desired(change, current);
        future(next.date);
        pending.push({ ...change, reviewed: current, desired: next });
      } else pending.push({ ...change, reviewed: current });
    }
    return {
      changed: differences.length > 0,
      payload: {
        ...payload,
        pending,
        context: await contextFor(pending),
        notice: differences.length
          ? { kind: "changed", differences, additional: payload.finished.length > 0 }
          : payload.notice,
      },
    };
  }
  async function execute(record: Record, payload: Payload, book: Phrasebook): Promise<Outcome> {
    let remaining = [...payload.pending];
    const finished = [...payload.finished];
    for (const change of payload.pending) {
      remaining = remaining.slice(1);
      const attemptId = randomUUID();
      await save(record, {
        kind: "executing",
        ...payload,
        pending: remaining,
        finished: [...finished],
        attempting: change,
        attemptId,
      });
      const result = await write(input.client, change);
      if (result.kind === "uncertain") {
        const notice: Notice = { kind: "uncertain", change };
        await save(record, {
          kind: "uncertain",
          ...payload,
          pending: remaining,
          finished,
          attempting: change,
          attemptId,
          notice,
        });
        return {
          kind: "uncertain",
          text: `${successes(finished, book)}${renderNotice(notice, book)}`,
        };
      }
      if (result.kind === "rejected") {
        const notice: Notice = { kind: "rejected", change };
        await save(record, {
          kind: "retry-ready",
          ...payload,
          pending: [change, ...remaining],
          finished,
          notice,
          delivery: randomUUID(),
        });
        return {
          kind: "partial",
          text: `${successes(finished, book)}${renderNotice(notice, book)}`,
        };
      }
      finished.push({ kind: "confirmed-write", change, eventId: result.eventId });
      await save(record, {
        kind: "preflighting",
        ...payload,
        pending: remaining,
        finished: [...finished],
      });
    }
    await save(record, { kind: "completed", finished });
    return {
      kind: "completed",
      text: `${successes(finished, book)}${book.say("workouts.outcome.complete")}`,
    };
  }
  async function recoverRecords(): Promise<void> {
    await verifyAccount();
    for (const record of store.records.values()) {
      const state = record.state;
      if (state.kind === "staged" || state.kind === "incomplete") {
        await save(
          { ...record, settledTurns: [...record.settledTurns, state.turnId] },
          { kind: "abandoned", finished: state.finished, delivery: randomUUID() },
        );
      } else if (state.kind === "preflighting") {
        await save(record, {
          ...state,
          kind: "retry-ready",
          delivery: randomUUID(),
          notice: { kind: "recoveredStopped" },
        });
      } else if (state.kind === "executing" || state.kind === "uncertain") {
        const uncertain = {
          ...state,
          kind: "uncertain" as const,
          notice: { kind: "recoveredUncertain" as const },
        };
        await save(record, uncertain);
        const change = state.attempting;
        try {
          let found: number | undefined;
          if (change.kind === "add") {
            const matches = (await readDay(input.client, change.prepared.date)).filter(
              (event) => event.externalId === change.recoveryIdentity,
            );
            const match = matches.length === 1 ? matches[0] : undefined;
            if (match !== undefined) {
              const expected = {
                eventId: match.id,
                date: change.prepared.date,
                name: change.prepared.name,
                durationSeconds: change.prepared.durationSeconds,
                description: change.prepared.description.replace(/\r\n/g, "\n"),
                trainingLoad: change.prepared.trainingLoad,
                structure: normalizeJson(change.prepared.structure),
              };
              if (sameSnapshot(snapshot(match), expected)) found = match.id;
            }
          } else if (change.kind === "edit") {
            const event = await readEvent(input.client, change.reviewed.eventId);
            if (sameSnapshot(snapshot(event), change.desired)) found = event.id;
          }
          if (change.kind === "delete") {
            const observed = await input.client.events.get(change.reviewed.eventId);
            if (!observed.ok && observed.error.kind === "NotFound")
              await save(record, {
                ...uncertain,
                notice: { kind: "recoveredDeleteAbsent", change },
              });
          }
          if (found !== undefined) {
            const finished = [
              ...state.finished,
              { kind: "observed-desired-state" as const, change, eventId: found },
            ];
            await save(
              record,
              state.pending.length === 0
                ? { kind: "completed", finished }
                : {
                    kind: "retry-ready",
                    pending: state.pending,
                    finished,
                    context: state.context,
                    notice: { kind: "recoveredObserved" },
                    delivery: randomUUID(),
                  },
            );
          }
        } catch {
          continue;
        }
      }
    }
  }
  const service: WorkoutChangeSets = {
    preparation: {
      readPending: (request) =>
        serial(async () => {
          await verifyAccount();
          const record = store.records.get(request.chatId);
          const state = record?.state;
          if (
            record === undefined ||
            state === undefined ||
            state.kind === "completed" ||
            state.kind === "canceled" ||
            state.kind === "abandoned"
          )
            return { kind: "none" };
          if (
            state.kind !== "review-ready" &&
            state.kind !== "retry-ready" &&
            state.kind !== "awaiting-approval" &&
            state.kind !== "blocked"
          )
            return {
              kind: "unavailable",
              reason: "The pending proposal cannot be revised in its current state.",
            };
          const changes: PendingWorkoutItem[] = state.pending.map((change) => {
            switch (change.kind) {
              case "add":
                return { id: change.id, change: change.prepared };
              case "edit":
                return {
                  id: change.id,
                  change: { kind: "edit", eventId: change.reviewed.eventId, patch: change.patch },
                  reviewed: change.reviewed,
                  desired: change.desired,
                };
              case "delete":
                return {
                  id: change.id,
                  change: { kind: "delete", eventId: change.reviewed.eventId },
                  reviewed: change.reviewed,
                };
            }
          });
          return structuredClone({
            kind: "pending",
            reference: { setId: record.setId, revision: record.revision },
            changes,
            completedCount: state.finished.length,
          });
        }),
      prepare: (request) =>
        serial(async () => {
          const previous = store.records.get(request.chatId);
          if (previous?.settledTurns.includes(request.turnId))
            return { kind: "refused", message: "This preparation turn is already settled." };
          if (previous?.state.kind === "uncertain" || previous?.state.kind === "executing")
            return {
              kind: "refused",
              message: "Resolve the uncertain calendar result before preparing more changes.",
            };
          if (
            (previous?.state.kind === "staged" || previous?.state.kind === "incomplete") &&
            previous.state.turnId === request.turnId
          ) {
            await save(previous, {
              kind: "incomplete",
              turnId: request.turnId,
              finished: previous.state.finished,
            });
            return {
              kind: "incomplete",
              message:
                "Multiple proposals were submitted in one turn. Prepare the complete set again in a new turn.",
            };
          }
          const active =
            previous !== undefined &&
            (previous.state.kind === "review-ready" ||
              previous.state.kind === "retry-ready" ||
              previous.state.kind === "awaiting-approval" ||
              previous.state.kind === "blocked")
              ? previous.state
              : undefined;
          try {
            await verifyAccount();
            const preparation = preparationSchema.parse(request.preparation);
            if (preparation.kind === "incomplete" && active !== undefined)
              return {
                kind: "refused",
                message: "The revision could not be prepared; the previous proposal is unchanged.",
              };
            if (preparation.kind === "revise" || preparation.kind === "replace") {
              if (
                active === undefined ||
                previous === undefined ||
                preparation.base.setId !== previous.setId ||
                preparation.base.revision !== previous.revision
              )
                return {
                  kind: "refused",
                  message:
                    "The pending proposal changed. Read it again before preparing a revision.",
                };
            } else if (preparation.kind === "complete" && active !== undefined) {
              return {
                kind: "refused",
                message:
                  "A proposal is already pending. Read it and use a targeted revision or explicit whole-set replacement.",
              };
            }
            const retain =
              previous !== undefined &&
              previous.state.kind !== "completed" &&
              previous.state.kind !== "canceled";
            const finished = retain ? previous.state.finished : [];
            const record: Record = {
              version: 1,
              account,
              chatId: request.chatId,
              setId: retain ? previous.setId : randomUUID(),
              revision: (previous?.revision ?? 0) + 1,
              settledTurns: previous?.settledTurns ?? [],
              state: { kind: "incomplete", turnId: request.turnId, finished },
            };
            if (preparation.kind === "incomplete") {
              await store.save(record);
              return { kind: "incomplete", message: preparation.reason };
            }
            const prepared = await preparePending({
              preparation,
              previous: active?.pending ?? [],
              client: input.client,
              today: today(input.timezone),
            });
            const context = await contextFor(prepared.pending);
            await save(record, {
              kind: "staged",
              turnId: request.turnId,
              pending: prepared.pending,
              finished,
              context,
              notice: prepared.notice,
            });
            return { kind: "prepared", changeCount: prepared.pending.length };
          } catch (error) {
            return {
              kind: "refused",
              message:
                error instanceof Error
                  ? error.message
                  : "The complete proposal could not be verified.",
            };
          }
        }),
      settleTurn: (request) =>
        serial(async () => {
          const record = store.records.get(request.chatId);
          if (!record || record.settledTurns.includes(request.turnId)) return;
          const state = record.state;
          if (
            (state.kind !== "staged" && state.kind !== "incomplete") ||
            state.turnId !== request.turnId
          )
            return;
          const next = { ...record, settledTurns: [...record.settledTurns, request.turnId] };
          await save(
            next,
            state.kind === "staged" && request.outcome === "commit"
              ? {
                  kind: "review-ready",
                  pending: state.pending,
                  finished: state.finished,
                  context: state.context,
                  notice: state.notice,
                  delivery: randomUUID(),
                }
              : { kind: "abandoned", finished: state.finished, delivery: randomUUID() },
          );
        }),
    },
    review: (request) =>
      serial(async () => {
        const book = await workoutPhrasebook(request.language);
        const record = store.records.get(request.chatId);
        if (!record) return null;
        const state = record.state;
        if (request.redisplay && (state.kind === "completed" || state.kind === "canceled"))
          return {
            handle: null,
            text: `${successes(state.finished, book)}${book.say(state.kind === "completed" ? "workouts.outcome.complete" : "workouts.outcome.canceled")}`,
          };
        if (state.kind === "uncertain" || state.kind === "blocked")
          return {
            handle: null,
            text: `${successes(state.finished, book)}${renderNotice(state.notice, book)}`,
          };
        if (state.kind === "abandoned") {
          if (state.delivery === null && !request.redisplay) return null;
          return {
            handle: state.delivery,
            text: `${successes(state.finished, book)}${book.say("workouts.outcome.incomplete")}`,
          };
        }
        if (state.kind === "awaiting-approval" && request.redisplay) {
          const delivery = randomUUID();
          await save(record, {
            kind: state.mode === "retry" ? "retry-ready" : "review-ready",
            pending: state.pending,
            finished: state.finished,
            context: state.context,
            notice: state.notice,
            delivery,
          });
          return { handle: delivery, text: renderReview(state, book) };
        }
        if (state.kind !== "review-ready" && state.kind !== "retry-ready") return null;
        return { handle: state.delivery, text: renderReview(state, book) };
      }),
    acknowledgeDelivery: (request) =>
      serial(async () => {
        const book = await workoutPhrasebook(request.language ?? "en");
        const record = store.records.get(request.chatId);
        if (record?.state.kind === "abandoned" && record.state.delivery === request.delivery) {
          await save(record, { ...record.state, delivery: null });
          return null;
        }
        if (
          !record ||
          (record.state.kind !== "review-ready" && record.state.kind !== "retry-ready") ||
          record.state.delivery !== request.delivery
        )
          return null;
        await verifyAccount();
        const state = record.state;
        const token = randomBytes(24).toString("base64url");
        const kind = state.kind === "retry-ready" ? "retry" : "approval";
        await save(record, {
          kind: "awaiting-approval",
          pending: state.pending,
          finished: state.finished,
          context: state.context,
          notice: state.notice,
          mode: kind,
          tokenDigest: digest(token),
        });
        return {
          token,
          kind,
          prompt: book.say(
            kind === "retry" ? "workouts.approval.retryPrompt" : "workouts.approval.applyPrompt",
          ),
        };
      }),
    resolve: (request) =>
      serial(async () => {
        const book = await workoutPhrasebook(request.language);
        const record = store.records.get(request.chatId);
        if (
          !record ||
          record.state.kind !== "awaiting-approval" ||
          record.state.tokenDigest !== digest(request.action.token)
        ) {
          const currentProposal =
            record?.state.kind === "review-ready" ||
            record?.state.kind === "retry-ready" ||
            record?.state.kind === "awaiting-approval";
          return {
            kind: "invalid-action",
            text: book.say(
              currentProposal
                ? "workouts.outcome.supersededApproval"
                : "workouts.outcome.invalidAction",
            ),
          };
        }
        const state = record.state;
        if (request.action.kind === "cancel") {
          await save(record, { kind: "canceled", finished: state.finished });
          return {
            kind: "canceled",
            text: `${successes(state.finished, book)}${book.say("workouts.outcome.canceled")}`,
          };
        }
        if (
          (state.mode === "approval" && request.action.kind !== "approve") ||
          (state.mode === "retry" && request.action.kind !== "retry-remaining")
        )
          return { kind: "invalid-action", text: book.say("workouts.outcome.wrongAction") };
        const claimed = await save(
          { ...record, revision: record.revision + 1 },
          {
            kind: "preflighting",
            pending: state.pending,
            finished: state.finished,
            context: state.context,
            notice: state.notice,
          },
        );
        let checked: Awaited<ReturnType<typeof preflight>>;
        try {
          checked = await preflight({
            pending: state.pending,
            finished: state.finished,
            context: state.context,
            notice: state.notice,
          });
        } catch (error) {
          const notice: Notice = { kind: "blocked", reason: workoutProblemKind(error) };
          await save(claimed, {
            kind: "blocked",
            pending: state.pending,
            finished: state.finished,
            context: state.context,
            notice,
          });
          return {
            kind: "blocked",
            text: `${successes(state.finished, book)}${renderNotice(notice, book)} ${book.say(state.finished.length ? "workouts.outcome.noAdditional" : "workouts.outcome.noChanges")}`,
          };
        }
        if (checked.changed) {
          await save(
            { ...claimed, revision: claimed.revision + 1 },
            { kind: "review-ready", ...checked.payload, delivery: randomUUID() },
          );
          return {
            kind: "refresh-required",
            text: `${successes(state.finished, book)}${renderNotice(checked.payload.notice, book)} ${book.say("workouts.outcome.refresh")}`,
          };
        }
        return execute(claimed, checked.payload, book);
      }),
    recover: () => serial(recoverRecords),
    async close() {
      await queue;
      closed = true;
      store.close();
    },
  };
  try {
    await service.recover();
  } catch (error) {
    await service.close();
    throw error;
  }
  return service;
}
