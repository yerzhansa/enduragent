import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { PlatformImportArtifact } from "@enduragent/kernel/ingest";
import type { ClockPort, HttpPort } from "@enduragent/kernel/ports";
import type {
  DerivedCaptureMembers,
  ReferenceCaptureEndpointPayload,
  ReferenceCapturePlan,
} from "@enduragent/kernel/reference/capture";
import type {
  AnchorHistoryRow,
  WellnessLandingRow,
  ZoneSetHistoryRow,
} from "@enduragent/kernel/store";
import type {
  RawFileSourceArtifact,
  SnapshotSourceArtifact,
  SourceCheckpoint,
  SourceWatermark,
  PhysicalRequestLedger,
  SyncBudget,
  SyncSource,
} from "@enduragent/kernel/store";
import type { CaptureReport } from "./lane-report.js";

export const INTERVALS_ICU_SOURCE_ID = "intervals-icu" as const;
export const INTERVALS_ICU_CAPABILITIES = Object.freeze({
  activities: true,
  streams: true,
  rawFiles: true,
  wellness: true,
  plannedWorkoutPush: false,
  backfillDepth: Object.freeze({ kind: "full-history" as const }),
});

export const MAX_JSON_BYTES = 67_108_864;

export interface DroppedActivityRowCounts {
  readonly sourceRestricted: number;
  readonly other: number;
}

export interface DroppedActivityRowEvidence extends DroppedActivityRowCounts {
  readonly datedLocalDates: readonly string[];
  readonly undatedCount: number;
}

export const ZERO_DROPPED_ACTIVITY_ROWS: DroppedActivityRowEvidence = Object.freeze({
  sourceRestricted: 0,
  other: 0,
  datedLocalDates: Object.freeze([]),
  undatedCount: 0,
});

export type IntervalsHttpFactory = (args: {
  readonly outer: AbortSignal;
  readonly perRequestTimeoutMs: number;
}) => HttpPort;

export interface IntervalsLandingAcl {
  activity(row: Record<string, unknown>): Readonly<Record<string, unknown>>;
  streams(value: unknown): Readonly<Record<string, unknown>>;
  assertClean(value: unknown): void;
}

export interface IntervalsIcuSourceOptions {
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly historyOldestDate?: string;
  readonly minRequestIntervalMs: number;
  readonly httpFactory: IntervalsHttpFactory;
  readonly archive: ArchiveManager;
  readonly acl: IntervalsLandingAcl;
  readonly wallClock: Pick<ClockPort, "now">;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly attemptLedger?: PhysicalRequestLedger;
}

export type IntervalsIcuArtifact =
  | (SnapshotSourceArtifact & {
      readonly source: "intervals-icu";
      readonly landing:
        | { readonly kind: "activity"; readonly platform: PlatformImportArtifact }
        | { readonly kind: "streams"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string }
        | { readonly kind: "wellness"; readonly row: WellnessLandingRow }
        | { readonly kind: "settings"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string; readonly anchors: readonly AnchorHistoryRow[]; readonly zones: readonly ZoneSetHistoryRow[] };
    })
  | (RawFileSourceArtifact & {
      readonly kind: "raw-file";
      readonly source: "intervals-icu";
      readonly lane: "bulk-fit";
      readonly externalId: string;
      readonly container: {
        readonly externalId: string;
        readonly archiveInstant: { readonly epochSeconds: number };
        readonly archive: { readonly address: string; readonly relPath: string; readonly deduped: boolean };
      } | null;
    })
  | IntervalsIcuCheckpoint;

export type IntervalsIcuCheckpoint = SourceCheckpoint & {
  readonly droppedActivityRows?: DroppedActivityRowEvidence;
};

export interface IntervalsIcuSource extends SyncSource {
  readonly id: "intervals-icu";
  readonly capabilities: typeof INTERVALS_ICU_CAPABILITIES;
  pull(watermark: SourceWatermark, budget: SyncBudget): AsyncIterable<IntervalsIcuArtifact>;
}

export interface IntervalsIcuCaptureSource extends IntervalsIcuSource {
  captureReference(plan: ReferenceCapturePlan, budget: SyncBudget): Promise<ReferenceCaptureBatch>;
  deriveReferenceCaptureMembers(
    plan: ReferenceCapturePlan,
    endpointPayloads: readonly ReferenceCaptureEndpointPayload[],
  ): Promise<DerivedCaptureMembers>;
}

export interface ReferenceCaptureEndpoint extends ReferenceCaptureEndpointPayload {
  readonly archiveInstant: { readonly epochSeconds: number };
  readonly archive: { readonly address: string; readonly relPath: string; readonly deduped: boolean };
}

interface ReferenceCaptureRecordBase {
  readonly endpointOrdinal: number;
  readonly payloadIndex: number | null;
  readonly externalId: string;
  readonly payload: unknown;
  readonly archiveInstant: { readonly epochSeconds: number };
  readonly archive: { readonly address: string; readonly relPath: string; readonly deduped: boolean };
}

export interface ReferenceCaptureSettingsRecord extends ReferenceCaptureRecordBase {
  readonly landing: { readonly kind: "settings"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string; readonly anchors: readonly AnchorHistoryRow[]; readonly zones: readonly ZoneSetHistoryRow[] };
}

export interface ReferenceCaptureActivityRecord extends ReferenceCaptureRecordBase {
  readonly landing: { readonly kind: "activity"; readonly platform: PlatformImportArtifact };
}

export interface ReferenceCaptureWellnessRecord extends ReferenceCaptureRecordBase {
  readonly landing: { readonly kind: "wellness"; readonly row: WellnessLandingRow };
}

export interface ReferenceCaptureStreamRecord extends ReferenceCaptureRecordBase {
  readonly landing: { readonly kind: "streams"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string };
}

export interface ReferenceCaptureBatch {
  readonly plan: ReferenceCapturePlan;
  readonly endpoints: readonly ReferenceCaptureEndpoint[];
  readonly records: {
    readonly settings: readonly ReferenceCaptureSettingsRecord[];
    readonly activities: readonly ReferenceCaptureActivityRecord[];
    readonly wellness: readonly ReferenceCaptureWellnessRecord[];
    readonly streams: readonly ReferenceCaptureStreamRecord[];
  };
  readonly selected_stream_ids: readonly string[];
  readonly captured_stream_ids: readonly string[];
  readonly report: CaptureReport;
}
