import {
  PlanChangeModelSchema,
  PlanChangeIntentSchema,
  PlanCloseRpcParamsSchema,
  PlanChangeFtpSourcesSchema,
  PlanChangeEventSourceSchema,
  PlanChangeApplyRpcParamsSchema,
  PlanChangeApplyResultSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangePreviewResultSchema,
  PlanCreationDraftSchema,
  type PlanChangeIntent,
  type PlanChangeRequest,
  type PlanChangeEventSource,
  type PlanCreationDraft,
  type PlanChangeOperations,
  type PlanChangeModel,
  type PlanChangesPaused,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanChangeRepository,
  createPlanWorkoutMatchRepository,
  PlanChangeEnvelopeSchema,
  PlanChangePreviewStoreResultSchema,
  dateKeyFromText,
  type PlanWorkoutRecord,
  type PlanChangeRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  applyScheduleIntent,
  applySupportingEventIntent,
  supportingEventWorkoutLimitExplanation,
  planChangeRaceWindow,
  readCyclingPlanFtpCandidates,
  readTodayChoice,
} from "@enduragent/sport-cycling";
import type { PlanFtpAdapter } from "@enduragent/engine/sport";
import { z } from "zod";
import type { IntentTranslationPort } from "@enduragent/engine";
import { supportedChangeKinds, translateChangeRequest } from "./plan-change-translator.js";

export const PROPOSAL_STALE_AFTER_HOURS = 24;

export async function readPlanChangesPaused(input: {
  calendarConnected: () => Promise<boolean>;
  syncStatus: () => Promise<{ lastSuccessfulSyncAtMs: number | null; awaitingSync: boolean }>;
  now: () => number;
}): Promise<PlanChangesPaused> {
  if (!(await input.calendarConnected())) return null;
  const { lastSuccessfulSyncAtMs } = await input.syncStatus();
  return lastSuccessfulSyncAtMs !== null &&
    input.now() - lastSuccessfulSyncAtMs > PROPOSAL_STALE_AFTER_HOURS * 60 * 60 * 1000
    ? { reason: "sync-stale", lastSuccessfulSyncAtMs }
    : null;
}

const DraftIdSchema = z.object({ id: z.string() }).passthrough();

const titles = {
  "weekday-duration": "Limit weekday duration",
  "weekday-unavailable": "Keep a weekday free",
  "hard-weekday": "No hard training on a weekday",
  "weekly-duration": "Limit weekly duration",
  "longest-workout": "Limit the longest Workout",
  inverse: "Undo the latest Change",
  ftp: "Correct FTP",
  "choose-workout": "Choose a Workout for today",
} satisfies Record<Exclude<PlanChangeIntent["kind"], "supporting-event">, string>;

const eventTitles = {
  add: "Add a Supporting Event",
  remove: "Remove a Supporting Event",
  role: "Change a Supporting Event role",
  manual: "Correct a Supporting Event",
  "source-update": "Accept synchronized event details",
  name: "Rename a Supporting Event",
} satisfies Record<Extract<PlanChangeIntent, { kind: "supporting-event" }>["operation"], string>;

function supportingEventRules(draft: PlanCreationDraft) {
  const answers = draft.answeredSummaries.map((summary) => summary.answer);
  const availability = answers.find((answer) => answer.kind === "availability");
  const restriction = answers.find((answer) => answer.kind === "restriction");
  if (availability === undefined || restriction === undefined)
    throw new Error("The Plan snapshot is missing confirmed training limits.");
  return { availability, restriction: restriction.restriction };
}

function metadataChanged(before: PlanCreationDraft, after: PlanCreationDraft): boolean {
  return (
    before.ftp !== after.ftp ||
    canonicalJson(before.supportingEvents) !== canonicalJson(after.supportingEvents)
  );
}

function invalidEventExplanation(issues: readonly z.core.$ZodIssue[]): string {
  const paths = issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.errors.flatMap((errors) => errors.flatMap((error) => error.path))
      : issue.path,
  );
  if (paths.includes("role")) return "Choose Important or Training.";
  if (paths.includes("eventId")) return "Choose a Supporting Event already accepted in this Plan.";
  return "Enter the event name and exact date.";
}

async function readCompletedWorkoutIds(
  store: SqlStore,
  planId: string,
): Promise<ReadonlySet<string>> {
  const rows = await store.all(
    `SELECT workout.structure_json FROM plan_workout workout
    WHERE workout.plan_id=? AND EXISTS (
      SELECT 1 FROM plan_workout_match match
      WHERE match.plan_workout_id=workout.id AND match.plan_id=workout.plan_id
        AND match.decision='confirmed'
    )`,
    [planId],
  );
  return new Set(
    rows.map((row) => DraftIdSchema.parse(JSON.parse(z.string().parse(row.structure_json))).id),
  );
}

export async function readClosedPlanOccupiesToday(
  store: SqlStore,
  todayDateKey: number,
): Promise<boolean> {
  return (
    (await store.get(
      `SELECT 1 FROM plan_workout workout
    JOIN planning_plan plan ON plan.plan_id=workout.plan_id
    JOIN plan_reconciliation_item item ON item.plan_workout_id=workout.id
    JOIN plan_reconciliation_job job ON job.id=item.job_id
    WHERE plan.status='closed' AND workout.date_key=? AND item.date_key=?
      AND job.kind='mirror' AND item.operation='create' AND item.status IN ('created','verified')
    LIMIT 1`,
      [todayDateKey, todayDateKey],
    )) !== undefined
  );
}

export function projectTodayChoice(
  draft: z.infer<typeof PlanCreationDraftSchema>,
  todayDateKey: number,
  occupiedByClosedPlan: boolean,
  completedWorkoutIds: ReadonlySet<string> = new Set(),
) {
  if (draft.mode !== "flexible") return null;
  const answers = draft.answeredSummaries.map((summary) => summary.answer);
  const availability = answers.find((answer) => answer.kind === "availability");
  const restriction = answers.find((answer) => answer.kind === "restriction");
  if (availability === undefined || restriction === undefined) return null;
  return readTodayChoice({
    draft,
    todayDateKey,
    occupiedByClosedPlan,
    completedWorkoutIds,
    answers: { availability, restriction: restriction.restriction },
  });
}

function choiceRejection(
  choice: ReturnType<typeof projectTodayChoice>,
  workoutId: string,
): string | null {
  if (choice?.eligible.some((workout) => workout.workoutId === workoutId)) return null;
  return (
    choice?.blocked.find((workout) => workout.workoutId === workoutId)?.reason ??
    "This Workout is no longer eligible."
  );
}

function civilDate(todayDateKey: number): string {
  const text = String(todayDateKey);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

async function readAppliedIntent(
  store: SqlStore,
  planId: string,
  changeId: string,
): Promise<PlanChangeIntent | null> {
  const original = await store.get(
    "SELECT diff_json FROM plan_change WHERE id=? AND plan_id=? AND status='applied'",
    [changeId, planId],
  );
  if (original === undefined) return null;
  const envelope = PlanChangeEnvelopeSchema.parse(JSON.parse(z.string().parse(original.diff_json)));
  return PlanChangeModelSchema.shape.intent.parse(envelope.intent);
}

async function eventNeedsSource(
  store: SqlStore,
  planId: string,
  intent: Extract<PlanChangeIntent, { kind: "supporting-event" }>,
  inverse: boolean,
): Promise<boolean> {
  if (intent.operation === "add") return intent.providerId !== undefined;
  if (intent.operation === "manual") return false;
  const revisions = await store.all(
    "SELECT snapshot_json FROM plan_revision WHERE plan_id=? ORDER BY revision_number DESC LIMIT ?",
    [planId, inverse ? 2 : 1],
  );
  return revisions.some((revision) =>
    PlanCreationDraftSchema.parse(
      JSON.parse(z.string().parse(revision.snapshot_json)),
    ).supportingEvents.some(
      (event) => event.id === intent.eventId && event.source.kind === "synced",
    ),
  );
}

export async function projectPlanChanges(input: {
  repository: PlanChangeRepository;
  store: SqlStore;
  planId: string;
  todayDateKey: number;
}): Promise<PlanChangeModel[]> {
  const changes = await input.repository.listChanges(input.planId);
  if (!changes.some((change) => change.status === "applied"))
    return changes.map((change) => PlanChangeModelSchema.parse({ ...change, undo: null }));
  const context = await input.repository.readUndoContext(input.planId);
  const completedWorkoutIds = await readCompletedWorkoutIds(input.store, input.planId);
  return changes.map((change) => {
    let undo: PlanChangeModel["undo"] = null;
    if (change.status === "applied") {
      if (context === null) undo = { eligible: false, reason: "plan-changed" };
      else if (context.newestApplied?.changeId !== change.changeId)
        undo = { eligible: false, reason: "not-newest" };
      else if (PlanChangeModelSchema.shape.intent.parse(change.intent).kind === "inverse")
        undo = { eligible: false, reason: "inverse" };
      else if (
        change.resultRevisionNumber !== context.currentRevisionNumber ||
        context.previousSnapshotJson === null
      )
        undo = { eligible: false, reason: "plan-changed" };
      else {
        const draft = PlanCreationDraftSchema.parse(JSON.parse(context.snapshotJson));
        const restored = applyScheduleIntent({
          draft,
          previousDraft: PlanCreationDraftSchema.parse(JSON.parse(context.previousSnapshotJson)),
          intent: { kind: "inverse", changeId: change.changeId },
          completedWorkoutIds,
          todayDateKey: input.todayDateKey,
        });
        undo =
          restored.diff.length > 0 || metadataChanged(draft, restored.after)
            ? { eligible: true }
            : { eligible: false, reason: "nothing-to-restore" };
      }
    }
    return PlanChangeModelSchema.parse({ ...change, undo });
  });
}

export function createPlanChangeOperations(input: {
  store: SqlStore & Pick<MigratorStore, "transaction">;
  identity: AuthoredIdentity;
  crypto: Crypto;
  todayDateKey: () => number;
  now: () => number;
  calendarConnected: () => Promise<boolean>;
  ftp: Pick<PlanFtpAdapter, "read" | "saveManual">;
  logger: { warn(event: string): void };
  eventSources: { read(): Promise<PlanChangeEventSource[]> };
  translator?: IntentTranslationPort;
}): PlanChangeOperations {
  const sha256 = async (text: string): Promise<string> => {
    const digest = await input.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const repository = createPlanChangeRepository(input.store, {
    newId: () => input.identity.newUlid(),
    sha256,
  });
  const stamp = async (request: { commandId: string }) => {
    const requestDigest = await sha256(canonicalJson(request));
    const clock = input.identity.hlcStamp();
    return {
      commandId: request.commandId,
      requestDigest,
      nowMs: clock.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    };
  };
  const admit = async (store: SqlStore) =>
    (
      await readPlanChangesPaused({
        calendarConnected: input.calendarConnected,
        syncStatus: () => createPlanWorkoutMatchRepository(store).readSyncStatus(),
        now: input.now,
      })
    )?.reason ?? null;
  return {
    async "plan_change.preview"(request) {
      const parsed = PlanChangePreviewRpcParamsSchema.safeParse(request);
      if (!parsed.success) {
        PlanCloseRpcParamsSchema.parse({
          commandId: request.commandId,
          planId: request.planId,
          expectedVersion: request.expectedVersion,
        });
        const rawIntent =
          "intent" in request
            ? request.intent
            : request.request.kind === "intent"
              ? request.request.intent
              : undefined;
        const checkedIntent = PlanChangeIntentSchema.safeParse(rawIntent);
        if (rawIntent !== undefined && !checkedIntent.success)
          return {
            status: "rejected",
            reason: "invalid-intent",
            ...(rawIntent.kind === "supporting-event"
              ? { explanation: invalidEventExplanation(checkedIntent.error.issues) }
              : {}),
          };
        throw parsed.error;
      }
      const { planId, expectedVersion } = parsed.data;
      const changeRequest: PlanChangeRequest =
        "request" in parsed.data
          ? parsed.data.request
          : { kind: "intent", intent: parsed.data.intent };
      const command = await stamp(parsed.data);
      let intent: PlanChangeIntent;
      if (changeRequest.kind === "text") {
        const prior = await input.store.get(
          "SELECT request_digest,result_json FROM planning_command WHERE command_name='plan_change.preview' AND command_id=? AND status='succeeded'",
          [command.commandId],
        );
        if (prior !== undefined) {
          if (prior.request_digest !== command.requestDigest)
            return { status: "rejected", reason: "command-conflict" };
          const result = PlanChangePreviewStoreResultSchema.parse(
            JSON.parse(z.string().parse(prior.result_json)),
          );
          return PlanChangePreviewResultSchema.parse(
            result.status === "previewed"
              ? { ...result, change: { ...result.change, undo: null } }
              : result,
          );
        }
        const rejection = await admit(input.store);
        if (rejection !== null) return { status: "rejected", reason: rejection };
        const active = await input.store.get(
          "SELECT plan_id,version FROM planning_plan WHERE status='active'",
        );
        if (active === undefined) return { status: "rejected", reason: "no-active-plan" };
        if (active.plan_id !== planId || active.version !== expectedVersion)
          return { status: "rejected", reason: "stale-version" };
        const current = await repository.readUndoContext(planId);
        if (current === null) return { status: "rejected", reason: "no-active-plan" };
        const draft = PlanCreationDraftSchema.parse(JSON.parse(current.snapshotJson));
        const today = input.todayDateKey();
        const choice = projectTodayChoice(
          draft,
          today,
          await readClosedPlanOccupiesToday(input.store, today),
          await readCompletedWorkoutIds(input.store, planId),
        );
        const translated = await translateChangeRequest(changeRequest.text, {
          allowedKinds: supportedChangeKinds,
          eligibleWorkouts: (choice?.eligible ?? []).map(({ workoutId }) => ({ workoutId })),
          supportingEvents: draft.supportingEvents.map(({ id }) => ({ id })),
          ...(input.translator === undefined ? {} : { translator: input.translator }),
        });
        if (translated.status !== "translated")
          return {
            status: "rejected",
            reason: "unsupported-request",
            explanation:
              translated.status === "combined"
                ? "Ask for one change at a time."
                : translated.status === "no-eligible-workout"
                  ? "No eligible Workout can be selected today."
                  : "This request is not supported yet. Choose one of the available actions.",
          };
        intent = translated.intent;
      } else intent = changeRequest.intent;
      let occupiedByClosedPlan = false;
      let previewTodayDateKey: number;
      let ftpCandidates: Awaited<ReturnType<typeof readCyclingPlanFtpCandidates>> = [];
      let eventSources: PlanChangeEventSource[] = [];
      const result = await repository.preview({
        async admit(store) {
          const rejection = await admit(store);
          if (rejection !== null) return rejection;
          previewTodayDateKey = input.todayDateKey();
          if (intent.kind === "choose-workout")
            occupiedByClosedPlan = await readClosedPlanOccupiesToday(store, previewTodayDateKey);
          const original =
            intent.kind === "inverse"
              ? await readAppliedIntent(store, planId, intent.changeId)
              : null;
          if (intent.kind === "ftp" || original?.kind === "ftp")
            ftpCandidates = await readCyclingPlanFtpCandidates(input.ftp);
          const eventIntent =
            intent.kind === "supporting-event"
              ? intent
              : original?.kind === "supporting-event"
                ? original
                : null;
          if (
            eventIntent !== null &&
            (await eventNeedsSource(store, planId, eventIntent, intent.kind === "inverse"))
          )
            eventSources = await input.eventSources.read();
          return null;
        },
        command,
        planId,
        expectedVersion,
        nowMs: input.now(),
        changeId: input.identity.newUlid(),
        build({
          snapshotJson,
          previousSnapshotJson,
          newestApplied,
          currentRevisionNumber,
          completedWorkoutIds,
        }) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
          if (
            intent.kind === "inverse" &&
            (newestApplied?.changeId !== intent.changeId ||
              newestApplied.resultRevisionNumber !== currentRevisionNumber ||
              previousSnapshotJson === null ||
              PlanChangeModelSchema.shape.intent.parse(newestApplied.intent).kind === "inverse")
          )
            return { status: "rejected", reason: "invalid-intent" };
          if (intent.kind === "choose-workout") {
            const message = choiceRejection(
              projectTodayChoice(
                draft,
                previewTodayDateKey,
                occupiedByClosedPlan,
                completedWorkoutIds,
              ),
              intent.workoutId,
            );
            if (message !== null) return { status: "rejected", reason: "invalid-intent", message };
          }
          const transformation = {
            draft,
            completedWorkoutIds,
            todayDateKey: previewTodayDateKey,
          };
          const originalIntent =
            intent.kind === "inverse" && newestApplied !== null
              ? PlanChangeModelSchema.shape.intent.parse(newestApplied.intent)
              : null;
          const eventIntent =
            intent.kind === "supporting-event"
              ? intent
              : originalIntent?.kind === "supporting-event"
                ? originalIntent
                : null;
          const previousDraft =
            intent.kind === "inverse" && previousSnapshotJson !== null
              ? PlanCreationDraftSchema.parse(JSON.parse(previousSnapshotJson))
              : null;
          const existingEvent =
            eventIntent !== null && "eventId" in eventIntent
              ? [...draft.supportingEvents, ...(previousDraft?.supportingEvents ?? [])].find(
                  (event) => event.id === eventIntent.eventId,
                )
              : undefined;
          const providerId =
            eventIntent?.operation === "add"
              ? eventIntent.providerId
              : existingEvent?.source.kind === "synced"
                ? existingEvent.source.providerId
                : undefined;
          const eventSource = eventSources.find((source) => source.providerId === providerId);
          if (providerId !== undefined && eventSource === undefined)
            return {
              status: "rejected",
              reason: "invalid-intent",
              explanation:
                "Accept synchronized event updates through a fresh source-update preview.",
            };
          const transformed =
            intent.kind === "supporting-event"
              ? applySupportingEventIntent({
                  ...transformation,
                  intent,
                  ...(intent.operation === "add" ? { eventId: input.identity.newUlid() } : {}),
                  ...(eventSource === undefined ? {} : { source: eventSource }),
                  rules: supportingEventRules(draft),
                })
              : intent.kind === "inverse"
                ? applyScheduleIntent({
                    ...transformation,
                    intent,
                    previousDraft: previousDraft ?? PlanCreationDraftSchema.parse(null),
                  })
                : applyScheduleIntent({ ...transformation, intent });
          if (!("after" in transformed))
            return {
              status: "rejected",
              reason: "invalid-intent",
              explanation: transformed.explanation,
            };
          const { after, diff, totals } = transformed;
          if (eventIntent !== null) {
            const explanation = supportingEventWorkoutLimitExplanation(after);
            if (explanation !== null)
              return { status: "rejected", reason: "invalid-intent", explanation };
          }
          if (!PlanCreationDraftSchema.safeParse(after).success)
            return { status: "rejected", reason: "invalid-intent" };
          if (intent.kind === "inverse" && diff.length === 0 && !metadataChanged(draft, after))
            return { status: "rejected", reason: "invalid-intent" };
          const correctsFtp =
            intent.kind === "ftp" ||
            (intent.kind === "inverse" &&
              newestApplied !== null &&
              PlanChangeModelSchema.shape.intent.parse(newestApplied.intent).kind === "ftp");
          const window = correctsFtp
            ? null
            : planChangeRaceWindow({
                goal: draft.goal,
                diff,
                todayDateKey: transformation.todayDateKey,
              });
          if (window !== null) return { status: "rejected", reason: "race-window", window };
          return {
            afterSnapshotJson: canonicalJson(after),
            envelope: PlanChangeEnvelopeSchema.parse({
              title:
                intent.kind === "supporting-event"
                  ? eventTitles[intent.operation]
                  : titles[intent.kind],
              ...(intent.kind === "choose-workout"
                ? { details: "Only this Workout will receive today’s date after confirmation." }
                : {}),
              intent,
              diff,
              totals,
              supersedes: null,
              premises: [
                ...(changeRequest.kind === "text"
                  ? [
                      {
                        id: "request",
                        label: "Your request",
                        source: "Your typed change request",
                        value: changeRequest,
                      },
                    ]
                  : []),
                ...(eventSource === undefined
                  ? []
                  : [
                      {
                        id: "event-source",
                        label: "Supporting Event source at this decision",
                        source: "Intervals.icu event",
                        value: eventSource,
                      },
                    ]),
                ...(intent.kind === "choose-workout"
                  ? [
                      {
                        id: "today",
                        label: "Today",
                        source: "Your local day",
                        value: { date: civilDate(previewTodayDateKey) },
                      },
                    ]
                  : []),
                ...(correctsFtp
                  ? [
                      {
                        id: "ftp-sources",
                        label: "FTP source comparison at this decision",
                        source: "Saved profile and synchronized FTP evidence",
                        value: {
                          acceptedPlanFtp: draft.ftp,
                          requestedFtp: after.ftp,
                          candidates: ftpCandidates,
                        },
                      },
                    ]
                  : []),
                {
                  id: "confirmed-limits",
                  label: "Confirmed Plan limits",
                  source: "Your confirmed answers",
                  value: intent,
                },
                ...(intent.kind === "inverse" && newestApplied !== null
                  ? [
                      {
                        id: "undone-change",
                        label: "Applied Change",
                        source: "Plan history",
                        value: { changeId: newestApplied.changeId, title: newestApplied.title },
                      },
                    ]
                  : []),
              ],
              confidence:
                "Moderate confidence. Based on your confirmed limits and the available training record.",
            }),
          };
        },
      });
      return PlanChangePreviewResultSchema.parse(
        result.status === "previewed"
          ? { ...result, change: { ...result.change, undo: null } }
          : result,
      );
    },
    async "plan_change.apply"(request) {
      const parsed = PlanChangeApplyRpcParamsSchema.parse(request);
      const command = await stamp(parsed);
      let correctedWatts: number | null = null;
      const result = await repository.apply({
        admit,
        async admitChange(
          store,
          { snapshotJson, afterSnapshotJson, diff, todayDateKey, intent: rawIntent, premises },
        ) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(afterSnapshotJson));
          const parsedIntent = PlanChangeModelSchema.shape.intent.safeParse(rawIntent);
          const intent = parsedIntent.success ? parsedIntent.data : null;
          const eventPremise = premises.find((premise) => premise.id === "event-source");
          if (eventPremise !== undefined) {
            const source = PlanChangeEventSourceSchema.parse(eventPremise.value);
            const current = (await input.eventSources.read()).find(
              (candidate) => candidate.providerId === source.providerId,
            );
            if (current?.sourceRevision !== source.sourceRevision) return "event-source-changed";
          }
          if (intent?.kind === "choose-workout") {
            const today = z
              .object({ date: z.iso.date() })
              .strict()
              .safeParse(premises.find((premise) => premise.id === "today")?.value);
            if (!today.success || today.data.date !== civilDate(todayDateKey))
              return {
                status: "rejected",
                reason: "day-changed",
                message:
                  "The day changed while this choice was open. Request a fresh choice for today; no date was assigned.",
              };
            const message = choiceRejection(
              projectTodayChoice(
                PlanCreationDraftSchema.parse(JSON.parse(snapshotJson)),
                todayDateKey,
                await readClosedPlanOccupiesToday(store, todayDateKey),
                await readCompletedWorkoutIds(store, parsed.planId),
              ),
              intent.workoutId,
            );
            if (message !== null) return { status: "rejected", reason: "not-eligible", message };
          }
          const ftpPremise = premises.find((premise) => premise.id === "ftp-sources");
          if (ftpPremise !== undefined) {
            const sources = PlanChangeFtpSourcesSchema.parse(ftpPremise.value);
            const current = await readCyclingPlanFtpCandidates(input.ftp);
            if (canonicalJson(sources.candidates) !== canonicalJson(current))
              return "ftp-sources-changed";
          }
          if (intent?.kind === "ftp") {
            correctedWatts = intent.watts;
            return null;
          }
          const original =
            intent?.kind === "inverse"
              ? await readAppliedIntent(store, parsed.planId, intent.changeId)
              : null;
          if (original?.kind === "ftp") return null;
          const workouts = PlanChangeModelSchema.shape.diff.parse(diff);
          if (planChangeRaceWindow({ goal: draft.goal, diff: workouts, todayDateKey }) !== null)
            return "race-window";
          const changesEvents =
            intent?.kind === "supporting-event" || original?.kind === "supporting-event";
          if (
            changesEvents &&
            workouts.some(
              ({ after }) => after?.date != null && dateKeyFromText(after.date) < todayDateKey,
            )
          )
            return "stale-version";
          return changesEvents
            ? {
                mutablePinnedWorkoutIds: workouts.flatMap(({ before }) =>
                  before?.kind === "event" && before.supportingEventId !== undefined
                    ? [before.id]
                    : [],
                ),
              }
            : null;
        },
        command,
        planId: parsed.planId,
        changeId: parsed.changeId,
        expectedVersion: parsed.expectedVersion,
        decision: parsed.decision,
        nowMs: input.now(),
        todayDateKey: input.todayDateKey,
        mirrorJobId: input.identity.newUlid(),
        materialize(snapshotJson, currentWorkouts, diffIds) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
          const currentByDraftId = new Map(
            currentWorkouts.map((workout) => [
              DraftIdSchema.parse(JSON.parse(workout.structureJson)).id,
              workout,
            ]),
          );
          const insert: PlanWorkoutRecord[] = [];
          const update: PlanWorkoutRecord[] = [];
          const retained = new Set<string>();
          for (const workout of draft.weeks.flatMap((week) => week.workouts)) {
            if (workout.date === null || !diffIds.has(workout.id)) continue;
            const current = currentByDraftId.get(workout.id);
            const row: PlanWorkoutRecord = {
              id: current?.id ?? input.identity.newUlid(),
              planId: parsed.planId,
              dateKey: dateKeyFromText(workout.date),
              sport: "Ride",
              name: workout.name,
              durationS: Math.round(workout.minutes * 60),
              structureJson: canonicalJson(workout),
              origin: "coach",
              deviceId: command.deviceId,
              hlcPhysicalMs: command.hlcPhysicalMs,
              hlcCounter: command.hlcCounter,
            };
            retained.add(row.id);
            (current === undefined ? insert : update).push(row);
          }
          return {
            insert,
            update,
            delete: currentWorkouts
              .filter(
                (workout) =>
                  diffIds.has(DraftIdSchema.parse(JSON.parse(workout.structureJson)).id) &&
                  !retained.has(workout.id),
              )
              .map((workout) => workout.id),
          };
        },
      });
      if (result.status === "applied" && correctedWatts !== null) {
        try {
          await input.ftp.saveManual(correctedWatts);
        } catch {
          input.logger.warn("plan_change_manual_ftp_save_failed");
        }
      }
      return PlanChangeApplyResultSchema.parse(result);
    },
  };
}
