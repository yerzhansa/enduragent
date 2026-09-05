import {
  ConfigureRuntimeRpcParamsSchema,
  ConfigureRuntimeRpcResultSchema,
  DeleteArchivedConversationRpcParamsSchema,
  DeleteArchivedConversationRpcResultSchema,
  GetArchivedTranscriptPageRpcParamsSchema,
  GetArchivedTranscriptPageRpcResultSchema,
  GetRuntimeConfigRpcParamsSchema,
  GetRuntimeConfigRpcResultSchema,
  GetSetupStatusRpcParamsSchema,
  GetSetupStatusRpcResultSchema,
  GetTranscriptPageRpcParamsSchema,
  GetTranscriptPageRpcResultSchema,
  ListArchivedConversationsRpcParamsSchema,
  ListArchivedConversationsRpcResultSchema,
  GetUnitsPreferenceRpcParamsSchema,
  GetUnitsPreferenceRpcResultSchema,
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  OperationProgressEventSchema,
  SaveIntakeRpcParamsSchema,
  SaveIntakeRpcResultSchema,
  SetUnitsPreferenceRpcParamsSchema,
  SetUnitsPreferenceRpcResultSchema,
  SyncRpcParamsSchema,
  SyncRpcResultSchema,
  VerifyIntervalsCredentialRpcParamsSchema,
  VerifyIntervalsCredentialRpcResultSchema,
  type ConfigureRuntimeRpcParams,
  type ConfigureRuntimeRpcRefusalReason,
  type ConfigureRuntimeRpcResult,
  type DeleteArchivedConversationRpcParams,
  type DeleteArchivedConversationRpcResult,
  type GetArchivedTranscriptPageRpcParams,
  type GetArchivedTranscriptPageRpcResult,
  type GetRuntimeConfigRpcParams,
  type GetRuntimeConfigRpcResult,
  type GetSetupStatusRpcParams,
  type GetSetupStatusRpcResult,
  type GetTranscriptPageRpcParams,
  type GetTranscriptPageRpcResult,
  type ListArchivedConversationsRpcParams,
  type ListArchivedConversationsRpcResult,
  type GetUnitsPreferenceRpcParams,
  type GetUnitsPreferenceRpcResult,
  type CoachOperations,
  type ImportFilesRpcParams,
  type ImportFilesRpcResult,
  type OperationProgressEvent,
  type SaveIntakeRpcParams,
  type SaveIntakeRpcResult,
  type SetUnitsPreferenceRpcParams,
  type SetUnitsPreferenceRpcResult,
  type SyncRpcParams,
  type SyncRpcResult,
  type VerifyIntervalsCredentialRpcParams,
  type VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import { createIntakeRepository, createUnitsPreferenceRepository } from "@enduragent/kernel/store";
import {
  createAuthoredIdentity,
  type AthleteHome,
  type AuthoredIdentity,
} from "@enduragent/kernel-node/home";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import type { ImportReport } from "@enduragent/kernel/ingest";
import { runIntervalsBackfillInWriter } from "./backfill.js";
import type { LocalStoreRuntime } from "./composition.js";
import type { CoachStoreWriterContext } from "./runtime.js";
import { createUnitsPreferenceService } from "./units-preference.js";

export interface CreateCoachOperationsInput {
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: Pick<LocalStoreRuntime, "runWindowAfter" | "runExclusive" | "runActivityWrite">;
  readonly intervalsCredentials: Readonly<{
    read(): Promise<Readonly<{ apiKey: string; athleteId: string }>>;
  }>;
  readonly intervalsVerificationPending?: () => boolean;
  readonly historyNewestDate: () => string;
  readonly calendarTimeZone: () => string;
  readonly readTranscriptPage?: (
    request: GetTranscriptPageRpcParams,
  ) => Promise<GetTranscriptPageRpcResult>;
  readonly readArchivedConversations?: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly readArchivedTranscriptPage?: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
  readonly deleteArchivedConversation?: (
    request: DeleteArchivedConversationRpcParams,
  ) => Promise<DeleteArchivedConversationRpcResult>;
  readonly applyRuntimeConfig: (
    request: ConfigureRuntimeRpcParams,
    signal: AbortSignal,
  ) => Promise<ConfigureRuntimeRpcRefusalReason | void>;
  readonly verifyIntervalsCredential?: (
    request: VerifyIntervalsCredentialRpcParams,
    signal: AbortSignal,
  ) => Promise<VerifyIntervalsCredentialRpcResult>;
  readonly readRuntimeConfig?: () => GetRuntimeConfigRpcResult | Promise<GetRuntimeConfigRpcResult>;
}

export interface CoachOperationsDependencies {
  readonly importFiles?: typeof importFilesWithReport;
  readonly backfill?: typeof runIntervalsBackfillInWriter;
  readonly createIdentity?: (configDir: string) => AuthoredIdentity;
  readonly createIntakeRepository?: typeof createIntakeRepository;
  readonly runtimeConfigurationDeadlineMs?: number;
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

function importedWorkoutKeys(report: ImportReport): readonly string[] {
  const importedAddresses = [
    ...new Set(
      report.files.filter((file) => file.outcome === "imported").map((file) => file.address),
    ),
  ].sort();
  if (importedAddresses.length === 0) return [];
  const importedAddressSet = new Set(importedAddresses);
  const matchedAddresses = new Set<string>();
  const workoutKeys = new Set<string>();
  for (const cluster of report.clusters) {
    for (const member of cluster.members) {
      if (!importedAddressSet.has(member)) continue;
      matchedAddresses.add(member);
      workoutKeys.add(cluster.workout_key);
    }
  }
  if (importedAddresses.some((address) => !matchedAddresses.has(address))) {
    throw new Error("Imported file has no canonical workout.");
  }
  return [...workoutKeys].sort();
}

function createSerializedLane(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

// Must stay below the client call timeout so queued work cannot mutate after its caller detaches.
export const RUNTIME_CONFIGURATION_DEADLINE_MS = 25_000;

export function createCoachOperations(
  input: CreateCoachOperationsInput,
  dependencies: CoachOperationsDependencies = {},
): CoachOperations {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  const store = input.context.store;
  const archiveDir = input.home.archiveDir;
  const identity = (dependencies.createIdentity ?? createAuthoredIdentity)(input.home.configDir);
  const intake = (dependencies.createIntakeRepository ?? createIntakeRepository)(store);
  const unitsPreference = createUnitsPreferenceService(createUnitsPreferenceRepository(store));
  const importFiles = dependencies.importFiles ?? importFilesWithReport;
  const backfill = dependencies.backfill ?? runIntervalsBackfillInWriter;
  const runtimeConfigurationDeadlineMs =
    dependencies.runtimeConfigurationDeadlineMs ?? RUNTIME_CONFIGURATION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(runtimeConfigurationDeadlineMs) ||
    runtimeConfigurationDeadlineMs <= 0
  ) {
    throw new TypeError("Runtime configuration deadline is invalid.");
  }
  const enqueueRuntimeConfiguration = createSerializedLane();

  const deliver = (
    onEvent: ((event: OperationProgressEvent) => void) | undefined,
    event: OperationProgressEvent,
  ): void => {
    const parsed = OperationProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
    } catch {}
  };

  return {
    importFiles(request: ImportFilesRpcParams, onEvent): Promise<ImportFilesRpcResult> {
      const parsedRequest = ImportFilesRpcParamsSchema.parse(request);
      const paths = [...parsedRequest.paths];
      return input.runtime
        .runActivityWrite(async () => {
          deliver(onEvent, { phase: "started", completed: 0, total: paths.length });
          return importFiles({ inputPaths: paths, archiveDir, store });
        }, importedWorkoutKeys)
        .then(({ value: report, activityReadAvailable }) => {
          const result = ImportFilesRpcResultSchema.parse({
            schemaVersion: 2,
            files: {
              total: report.files.length,
              imported: report.files.filter((file) => file.outcome === "imported").length,
              quarantined: report.files.filter((file) => file.outcome === "quarantined").length,
            },
            changes: {
              rawFilesInserted: report.inserts.raw_file,
              sourceRecordsInserted: report.inserts.source_record,
              sourceRecordsUpdated: report.updates.source_record,
              relinkedSourceRecords: report.updates.relinked_source_records,
            },
            publication: {
              scope: "activities-and-streams",
              status: activityReadAvailable ? "available" : "retryable-failure",
            },
          });
          deliver(onEvent, { phase: "completed", completed: paths.length, total: paths.length });
          return result;
        });
    },
    sync(request: SyncRpcParams, onEvent): Promise<SyncRpcResult> {
      SyncRpcParamsSchema.parse(request);
      deliver(onEvent, { phase: "started", completed: 0, total: 1 });
      let backfillOutcome: SyncRpcResult["backfill"] = "completed";
      return input.runtime
        .runWindowAfter(async (signal) => {
          const credentials = await input.intervalsCredentials.read();
          if (credentials.apiKey.length === 0) {
            backfillOutcome =
              input.intervalsVerificationPending?.() === true
                ? "pending-verification"
                : "skipped-no-credential";
            return;
          }
          await backfill({
            home: input.home,
            store: input.context.store,
            apiKey: credentials.apiKey,
            athleteId: credentials.athleteId === "" ? "0" : credentials.athleteId,
            historyNewestDate: input.historyNewestDate(),
            calendarTimeZone: input.calendarTimeZone(),
            signal,
          });
        })
        .then((window) => {
          const result = SyncRpcResultSchema.parse({
            schemaVersion: 1,
            backfill: backfillOutcome,
            published: window.published,
            referenceSucceeded: window.legacySucceeded,
            requests: {
              store: window.counts.storeRequests,
              reference: window.counts.legacyRequests,
              total: window.counts.totalRequests,
            },
            droppedActivities: window.droppedActivities,
          });
          deliver(onEvent, { phase: "completed", completed: 1, total: 1 });
          return result;
        });
    },
    getSetupStatus(request: GetSetupStatusRpcParams): Promise<GetSetupStatusRpcResult> {
      GetSetupStatusRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () => {
        const [savedIntake, activity] = await Promise.all([
          intake.read(),
          store.get("SELECT 1 AS present FROM workout LIMIT 1"),
        ]);
        const present = activity?.present;
        if (present !== undefined && present !== 1) {
          throw new TypeError("setup activity evidence is invalid");
        }
        return GetSetupStatusRpcResultSchema.parse({
          schemaVersion: 1,
          intake:
            savedIntake === undefined
              ? null
              : {
                  swim_skill_floor: null,
                  continuous_distance_capable: null,
                  open_water_comfort: null,
                  prior_bsi: false,
                  clinician_cleared: savedIntake.clinician_cleared,
                  injury_status: savedIntake.injury_status,
                },
          durableTrainingData: present === 1,
        });
      });
    },
    saveIntake(request: SaveIntakeRpcParams): Promise<SaveIntakeRpcResult> {
      const parsedRequest = SaveIntakeRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () => {
        const deviceId = await identity.deviceId();
        const stamp = identity.hlcStamp();
        await intake.replace({
          id: identity.newUlid(),
          swim_skill_floor: parsedRequest.swim_skill_floor,
          continuous_distance_capable: parsedRequest.continuous_distance_capable,
          open_water_comfort: parsedRequest.open_water_comfort,
          clinician_cleared:
            parsedRequest.injury_status === "none" ? null : parsedRequest.clinician_cleared,
          injury_status: parsedRequest.injury_status,
          device_id: deviceId,
          hlc_physical_ms: stamp.physicalMs,
          hlc_counter: stamp.counter,
        });
        return SaveIntakeRpcResultSchema.parse({ schemaVersion: 1, saved: true });
      });
    },
    getTranscriptPage(request: GetTranscriptPageRpcParams): Promise<GetTranscriptPageRpcResult> {
      const parsedRequest = GetTranscriptPageRpcParamsSchema.parse(request);
      if (input.readTranscriptPage === undefined) {
        throw new TypeError("Transcript page read is unavailable.");
      }
      return input
        .readTranscriptPage(parsedRequest)
        .then((result) => GetTranscriptPageRpcResultSchema.parse(result));
    },
    listArchivedConversations(
      request: ListArchivedConversationsRpcParams,
    ): Promise<ListArchivedConversationsRpcResult> {
      const parsedRequest = ListArchivedConversationsRpcParamsSchema.parse(request);
      if (input.readArchivedConversations === undefined) {
        throw new TypeError("Archived conversation read is unavailable.");
      }
      return input
        .readArchivedConversations(parsedRequest)
        .then((result) => ListArchivedConversationsRpcResultSchema.parse(result));
    },
    getArchivedTranscriptPage(
      request: GetArchivedTranscriptPageRpcParams,
    ): Promise<GetArchivedTranscriptPageRpcResult> {
      const parsedRequest = GetArchivedTranscriptPageRpcParamsSchema.parse(request);
      if (input.readArchivedTranscriptPage === undefined) {
        throw new TypeError("Archived transcript page read is unavailable.");
      }
      return input
        .readArchivedTranscriptPage(parsedRequest)
        .then((result) => GetArchivedTranscriptPageRpcResultSchema.parse(result));
    },
    deleteArchivedConversation(
      request: DeleteArchivedConversationRpcParams,
    ): Promise<DeleteArchivedConversationRpcResult> {
      const parsedRequest = DeleteArchivedConversationRpcParamsSchema.parse(request);
      if (input.deleteArchivedConversation === undefined) {
        throw new TypeError("Archived conversation deletion is unavailable.");
      }
      return input
        .deleteArchivedConversation(parsedRequest)
        .then((result) => DeleteArchivedConversationRpcResultSchema.parse(result));
    },
    configureRuntime(
      request: ConfigureRuntimeRpcParams,
      callerSignal?: AbortSignal,
    ): Promise<ConfigureRuntimeRpcResult> {
      const parsedRequest = ConfigureRuntimeRpcParamsSchema.parse(request);
      const deadlineSignal = AbortSignal.timeout(runtimeConfigurationDeadlineMs);
      const requestSignal =
        callerSignal === undefined
          ? deadlineSignal
          : AbortSignal.any([deadlineSignal, callerSignal]);
      return enqueueRuntimeConfiguration(async () => {
        const apply = async (admissionSignal?: AbortSignal): Promise<ConfigureRuntimeRpcResult> => {
          const signal =
            admissionSignal === undefined
              ? requestSignal
              : AbortSignal.any([requestSignal, admissionSignal]);
          signal.throwIfAborted();
          const refusal = await input.applyRuntimeConfig(parsedRequest, signal);
          signal.throwIfAborted();
          if (refusal !== undefined) {
            return ConfigureRuntimeRpcResultSchema.parse({
              schemaVersion: 3,
              status: "refused",
              reason: refusal,
            });
          }
          return ConfigureRuntimeRpcResultSchema.parse({
            schemaVersion: 3,
            status: "applied",
            applied: {
              llm: parsedRequest.llm !== undefined,
              intervals: parsedRequest.intervals !== undefined,
              session: parsedRequest.session !== undefined,
            },
          });
        };
        return parsedRequest.intervals === undefined ? apply() : input.runtime.runExclusive(apply);
      });
    },
    verify_intervals_credential(
      request: VerifyIntervalsCredentialRpcParams,
      callerSignal?: AbortSignal,
    ): Promise<VerifyIntervalsCredentialRpcResult> {
      const parsedRequest = VerifyIntervalsCredentialRpcParamsSchema.parse(request);
      if (input.verifyIntervalsCredential === undefined) {
        throw new TypeError("Intervals credential verification is unavailable.");
      }
      const signal = callerSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      return input.verifyIntervalsCredential(parsedRequest, signal).then((result) => {
        signal.throwIfAborted();
        return VerifyIntervalsCredentialRpcResultSchema.parse(result);
      });
    },
    getRuntimeConfig(request: GetRuntimeConfigRpcParams): Promise<GetRuntimeConfigRpcResult> {
      GetRuntimeConfigRpcParamsSchema.parse(request);
      return enqueueRuntimeConfiguration(async () => {
        if (input.readRuntimeConfig === undefined) {
          throw new TypeError("Runtime configuration read is unavailable.");
        }
        return GetRuntimeConfigRpcResultSchema.parse(await input.readRuntimeConfig());
      });
    },
    getUnitsPreference(request: GetUnitsPreferenceRpcParams): Promise<GetUnitsPreferenceRpcResult> {
      GetUnitsPreferenceRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () =>
        GetUnitsPreferenceRpcResultSchema.parse(await unitsPreference.get()),
      );
    },
    setUnitsPreference(request: SetUnitsPreferenceRpcParams): Promise<SetUnitsPreferenceRpcResult> {
      const parsedRequest = SetUnitsPreferenceRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () =>
        SetUnitsPreferenceRpcResultSchema.parse(await unitsPreference.set(parsedRequest.value)),
      );
    },
  };
}
