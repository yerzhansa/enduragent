import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serializeReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import { CAPTURE_LANES, captureHealth, formatRowDrop, judgedDrops, type CaptureLane, type LaneReport } from "@enduragent/sync-intervals-icu";
import { referenceCaptureRunError, ReplacedCaptureNotReplayableError, runReferenceCapture } from "./capture.js";

interface CommandOptions {
  readonly reviewedOn: string;
  readonly reason: "initial" | "provider-refresh" | "schema-change" | "capture-invalid" | "operator-request";
  readonly replacesCaptureId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function realDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

type CaptureCommandExitCode = 0 | 1 | 2 | 3;

export const REPLACED_CAPTURE_REFUSAL =
  "REFERENCE_CAPTURE refused reason=replaced_capture_not_replayable. "
  + "The capture named by --replaces could not be loaded and replayed, so it cannot be replaced. "
  + "Nothing was written. Check the capture id. To start a new chain instead, run again with --reason initial and without --replaces.";

function formatLaneLine(lane: CaptureLane, report: LaneReport): string {
  const dropped = judgedDrops(report);
  const [firstDrop] = dropped;
  const [firstUnfetched] = report.unfetched;
  return `REFERENCE_CAPTURE lane=${lane} fetched=${report.fetched} landed=${report.landed}`
    + ` dropped=${dropped.length} withheld=${report.drops.length - dropped.length} unfetched=${report.unfetched.length}`
    + (firstDrop === undefined ? "" : ` first_drop="${formatRowDrop(firstDrop)}"`)
    + (firstUnfetched === undefined ? "" : ` first_unfetched="${formatRowDrop(firstUnfetched)}"`);
}

export interface CaptureCommandDependencies {
  readonly runCapture?: typeof runReferenceCapture;
  readonly uuid?: () => string;
  readonly wallClock?: () => Date;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

function parseArgs(args: readonly string[]): CommandOptions {
  const allowed = new Set(["--reviewed-on", "--reason", "--replaces"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag) || values.has(flag) || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new TypeError("invalid capture arguments");
    }
    values.set(flag, args[++index]);
  }
  const reviewedOn = values.get("--reviewed-on"), reason = values.get("--reason");
  if (reviewedOn === undefined || reason === undefined
    || !realDate(reviewedOn)
    || !["initial", "provider-refresh", "schema-change", "capture-invalid", "operator-request"].includes(reason)) {
    throw new TypeError("capture arguments are incomplete");
  }
  const replacement = values.get("--replaces");
  if ((reason === "initial") !== (replacement === undefined)
    || (replacement !== undefined && !UUID.test(replacement))) throw new TypeError("capture replacement is invalid");
  return { reviewedOn, reason: reason as CommandOptions["reason"],
    ...(replacement === undefined ? {} : { replacesCaptureId: replacement }) };
}

function requiredEnvironment(env: Record<string, string | undefined>): { apiKey: string; athleteId: string } {
  if (env.REFERENCE_CAPTURE_ENABLE !== "1" || !env.REFERENCE_CAPTURE_API_KEY
    || !env.REFERENCE_CAPTURE_ATHLETE_ID || !env.ENDURAGENT_HOME) {
    throw new TypeError("capture environment is invalid");
  }
  return { apiKey: env.REFERENCE_CAPTURE_API_KEY, athleteId: env.REFERENCE_CAPTURE_ATHLETE_ID };
}

export async function runCaptureReferenceCommand(
  args: readonly string[],
  env: Record<string, string | undefined>,
  dependencies: CaptureCommandDependencies = {},
): Promise<CaptureCommandExitCode> {
  const stdout = dependencies.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let options: CommandOptions, credentials: { apiKey: string; athleteId: string };
  try { options = parseArgs(args); credentials = requiredEnvironment(env); }
  catch {
    stderr("REFERENCE_CAPTURE failed category=environment");
    return 2;
  }
  try {
    const { manifest, report } = await (dependencies.runCapture ?? runReferenceCapture)({ env, apiKey: credentials.apiKey,
      athleteId: credentials.athleteId, calendarTimeZone: "UTC", reviewedOn: options.reviewedOn,
      reason: options.reason,
      ...(options.replacesCaptureId === undefined ? {} : { replacesCaptureId: options.replacesCaptureId }) }, {
      uuid: dependencies.uuid ?? randomUUID,
      wallClock: dependencies.wallClock ?? (() => new Date()),
    });
    const hash = createHash("sha256").update(serializeReferenceCaptureManifest(manifest)).digest("hex");
    stdout(`REFERENCE_CAPTURE recorded activities=${manifest.records.activities.length} wellness=${manifest.records.wellness.length} settings=${manifest.records.settings.length} streams=${manifest.records.streams.length} evidence_sha256=${hash}`);
    for (const lane of CAPTURE_LANES) {
      if (report[lane].drops.length > 0 || report[lane].unfetched.length > 0) stdout(formatLaneLine(lane, report[lane]));
    }
    const health = captureHealth(report);
    if (health.status === "ok") return 0;
    stderr(`REFERENCE_CAPTURE degraded lost=${CAPTURE_LANES.filter((lane) => health.lanes[lane] === "lost").join(",")}`);
    return 3;
  } catch (error) {
    const failure = referenceCaptureRunError(error);
    stderr(`REFERENCE_CAPTURE failed category=${failure?.category ?? "capture"}`);
    if (failure?.cause instanceof ReplacedCaptureNotReplayableError) stderr(REPLACED_CAPTURE_REFUSAL);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCaptureReferenceCommand(process.argv.slice(2), process.env);
}
