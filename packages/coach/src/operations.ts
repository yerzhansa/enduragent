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
  GetLanguagePreferenceRpcParamsSchema,
  GetUnitsPreferenceRpcParamsSchema,
  GetLanguagePreferenceRpcResultSchema,
  GetUnitsPreferenceRpcResultSchema,
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  OperationProgressEventSchema,
  SetLanguagePreferenceRpcParamsSchema,
  SetUnitsPreferenceRpcParamsSchema,
  SetLanguagePreferenceRpcResultSchema,
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
  type GetLanguagePreferenceRpcParams,
  type GetUnitsPreferenceRpcParams,
  type GetLanguagePreferenceRpcResult,
  type GetUnitsPreferenceRpcResult,
  type CoachOperations,
  type ImportFilesRpcParams,
  type ImportFilesRpcResult,
  type OperationProgressEvent,
  type SetLanguagePreferenceRpcParams,
  type SetUnitsPreferenceRpcParams,
  type SetLanguagePreferenceRpcResult,
  type SetUnitsPreferenceRpcResult,
  type SyncRpcParams,
  type SyncRpcResult,
  type VerifyIntervalsCredentialRpcParams,
  type VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import {
  createLanguagePreferenceRepository,
  createUnitsPreferenceRepository,
} from "@enduragent/kernel/store";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import { createSubsystemLogger, isIntervalsCredentialRejected } from "@enduragent/core";
import type { ImportReport } from "@enduragent/kernel/ingest";
import { runIntervalsBackfillInWriter } from "./backfill.js";
import { readBackfillState } from "./backfill-state.js";
import type { LocalStoreRuntime } from "./composition.js";
import { isIntervalsCredentialUsable } from "./intervals-credential-usable.js";
import type { CoachStoreWriterContext } from "./runtime.js";
import { createUnitsPreferenceService } from "./units-preference.js";

import {
  createLanguagePreferenceService,
  type LanguagePreferenceService,
} from "./language-preference.js";
import { sameHome } from "./same-home.js";

export interface CreateCoachOperationsInput {
  readonly languagePreference?: LanguagePreferenceService;
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: Pick<
    LocalStoreRuntime,
    | "runWindowAfter"
    | "runExclusive"
    | "runOutsideWindow"
    | "abortActiveWindow"
    | "runActivityWrite"
  >;
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
  readonly readRuntimeConfig?: () => GetRuntimeConfigRpcResult;
}

export interface LocalCoachOperations extends CoachOperations {
  resumeHistoryDownload(signal: AbortSignal): Promise<void>;
}

export interface CoachOperationsDependencies {
  readonly importFiles?: typeof importFilesWithReport;
  readonly backfill?: typeof runIntervalsBackfillInWriter;
  readonly runtimeConfigurationDeadlineMs?: number;
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
    tail = Promise.allSettled([task]).then(() => undefined);
    return task;
  };
}

const CLIENT_RUNTIME_CONFIGURATION_CALL_TIMEOUT_MS = 30_000;
const MARGIN_BEFORE_CALLER_DETACHES_MS = 5_000;
export const RUNTIME_CONFIGURATION_DEADLINE_MS =
  CLIENT_RUNTIME_CONFIGURATION_CALL_TIMEOUT_MS - MARGIN_BEFORE_CALLER_DETACHES_MS;

export function createCoachOperations(
  input: CreateCoachOperationsInput,
  dependencies: CoachOperationsDependencies = {},
): LocalCoachOperations {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  const store = input.context.store;
  const archiveDir = input.home.archiveDir;
  const languagePreference =
    input.languagePreference ??
    createLanguagePreferenceService(createLanguagePreferenceRepository(store));
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
  let offeredIntervalsCredential = "";
  const intervalsCredentialRejected = (applied: string): boolean => {
    const credential = applied.length > 0 ? applied : offeredIntervalsCredential;
    return credential.length > 0 && isIntervalsCredentialRejected(credential);
  };

  const downloadHistory = (
    credentials: Readonly<{ apiKey: string; athleteId: string }>,
    signal: AbortSignal,
    fetchOffStoreLane: typeof globalThis.fetch,
  ) =>
    backfill({
      home: input.home,
      store,
      apiKey: credentials.apiKey,
      athleteId: credentials.athleteId === "" ? "0" : credentials.athleteId,
      historyNewestDate: input.historyNewestDate(),
      calendarTimeZone: input.calendarTimeZone(),
      signal,
      baseFetch: fetchOffStoreLane,
    });
  const resumableHistoryCredentials = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const credentials = await input.intervalsCredentials.read();
    if (!isIntervalsCredentialUsable(credentials.apiKey)) return undefined;
    return (await readBackfillState(store)).kind === "in-progress" ? credentials : undefined;
  };

  const deliver = (
    onEvent: ((event: OperationProgressEvent) => void) | undefined,
    event: OperationProgressEvent,
  ): boolean => {
    const parsed = OperationProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
      return true;
    } catch {
      return false;
    }
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
        .runWindowAfter(async (signal, fetchOffStoreLane) => {
          const credentials = await input.intervalsCredentials.read();
          if (credentials.apiKey.length === 0) {
            backfillOutcome =
              input.intervalsVerificationPending?.() === true
                ? "pending-verification"
                : "skipped-no-credential";
            return;
          }
          await downloadHistory(credentials, signal, fetchOffStoreLane);
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
    async resumeHistoryDownload(signal): Promise<void> {
      try {
        const pending = await input.runtime.runExclusive(() => resumableHistoryCredentials(signal));
        if (pending === undefined) return;
        await input.runtime.runWindowAfter(async (windowSignal, fetchOffStoreLane) => {
          const resumeSignal = AbortSignal.any([signal, windowSignal]);
          const credentials = await resumableHistoryCredentials(resumeSignal);
          if (credentials === undefined) return;
          await downloadHistory(credentials, resumeSignal, fetchOffStoreLane);
        });
      } catch (error) {
        if (signal.aborted) return;
        createSubsystemLogger("sync", input.home.root).error(
          "history_download_resume_failed",
          error,
        );
      }
    },
    getSetupStatus(request: GetSetupStatusRpcParams): Promise<GetSetupStatusRpcResult> {
      GetSetupStatusRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () => {
        const activity = await store.get("SELECT 1 AS present FROM workout LIMIT 1");
        const present = activity?.present;
        if (present !== undefined && present !== 1) {
          throw new TypeError("setup activity evidence is invalid");
        }
        return GetSetupStatusRpcResultSchema.parse({
          schemaVersion: 1,
          durableTrainingData: present === 1,
        });
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
      const releaseWindow =
        parsedRequest.intervals?.clear_credential === true
          ? input.runtime.abortActiveWindow(new Error("intervals.icu credential cleared"))
          : undefined;
      const configured = enqueueRuntimeConfiguration(async () => {
        const apply = async (admissionSignal?: AbortSignal): Promise<ConfigureRuntimeRpcResult> => {
          const signal =
            admissionSignal === undefined
              ? requestSignal
              : AbortSignal.any([requestSignal, admissionSignal]);
          signal.throwIfAborted();
          if (parsedRequest.intervals?.api_key !== undefined) {
            offeredIntervalsCredential = parsedRequest.intervals.api_key;
          }
          const refusal = await input.applyRuntimeConfig(parsedRequest, signal);
          releaseWindow?.();
          if (refusal === undefined && parsedRequest.intervals?.clear_credential === true) {
            offeredIntervalsCredential = "";
          }
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
        return parsedRequest.intervals === undefined
          ? apply()
          : input.runtime.runOutsideWindow(apply);
      });
      return releaseWindow === undefined ? configured : configured.finally(releaseWindow);
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
        const snapshot = GetRuntimeConfigRpcResultSchema.parse(input.readRuntimeConfig());
        const { apiKey } = await input.intervalsCredentials.read();
        if (!intervalsCredentialRejected(apiKey)) return snapshot;
        return { ...snapshot, intervals: { ...snapshot.intervals, credential_rejected: true } };
      });
    },
    getLanguagePreference(
      request: GetLanguagePreferenceRpcParams,
    ): Promise<GetLanguagePreferenceRpcResult> {
      GetLanguagePreferenceRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () =>
        GetLanguagePreferenceRpcResultSchema.parse(await languagePreference.get()),
      );
    },
    setLanguagePreference(
      request: SetLanguagePreferenceRpcParams,
    ): Promise<SetLanguagePreferenceRpcResult> {
      const parsedRequest = SetLanguagePreferenceRpcParamsSchema.parse(request);
      return input.runtime.runExclusive(async () =>
        SetLanguagePreferenceRpcResultSchema.parse(
          await languagePreference.set(parsedRequest.value),
        ),
      );
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
