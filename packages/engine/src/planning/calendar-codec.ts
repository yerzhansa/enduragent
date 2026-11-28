import type { IcuBaseline, IcuCopy, IcuSighting, IcuVersion } from "./icu-copy.js";
import type { AthleteChangesChoice, TickedChange } from "./plan-ending.js";
import type { WeekDelivery } from "./week-delivery.js";

export class CalendarCodecError extends Error {
  readonly code: "invalid-copy" | "invalid-delivery";

  constructor(code: CalendarCodecError["code"]) {
    super(`calendar state rejected: ${code}`);
    this.name = "CalendarCodecError";
    this.code = code;
  }
}

type Json = Readonly<Record<string, unknown>>;

function object(value: unknown, code: CalendarCodecError["code"]): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CalendarCodecError(code);
  }
  return Object.fromEntries(Object.entries(value));
}

function integer(value: unknown, code: CalendarCodecError["code"]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CalendarCodecError(code);
  return value;
}

function text(value: unknown, code: CalendarCodecError["code"]): string {
  if (typeof value !== "string") throw new CalendarCodecError(code);
  return value;
}

function weeks(value: unknown): readonly number[] {
  if (!Array.isArray(value)) throw new CalendarCodecError("invalid-delivery");
  return value.map((entry) => integer(entry, "invalid-delivery"));
}

function version(value: unknown): IcuVersion {
  const json = object(value, "invalid-copy");
  return {
    fingerprint: text(json.fingerprint, "invalid-copy"),
    updated: text(json.updated, "invalid-copy"),
  };
}

function baseline(value: unknown): IcuBaseline {
  const json = object(value, "invalid-copy");
  const owner = json.owner;
  if (owner !== "plan" && owner !== "athlete-edit") throw new CalendarCodecError("invalid-copy");
  return {
    eventId: integer(json.eventId, "invalid-copy"),
    dateKey: integer(json.dateKey, "invalid-copy"),
    planFingerprint: text(json.planFingerprint, "invalid-copy"),
    readBack: version(json.readBack),
    owner,
  };
}

function sighting(value: unknown): IcuSighting {
  const json = object(value, "invalid-copy");
  if (json.kind === "absent") return { kind: "absent" };
  if (json.kind !== "present") throw new CalendarCodecError("invalid-copy");
  return {
    kind: "present",
    eventId: integer(json.eventId, "invalid-copy"),
    dateKey: integer(json.dateKey, "invalid-copy"),
    version: version(json.version),
  };
}

export function decodeIcuCopy(json: string): IcuCopy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CalendarCodecError("invalid-copy");
  }
  const value = object(parsed, "invalid-copy");
  switch (value.kind) {
    case "not-sent":
      return {
        kind: "not-sent",
        owner: value.owner === "athlete-edit" ? "athlete-edit" : "plan",
      };
    case "removed-by-you":
      return { kind: "removed-by-you" };
    case "kept-as-yours":
      return { kind: "kept-as-yours", eventId: integer(value.eventId, "invalid-copy") };
    case "on-icu":
      return { kind: "on-icu", baseline: baseline(value.baseline) };
    case "moving-by-you":
      return { kind: "moving-by-you", baseline: baseline(value.baseline) };
    case "changed-in-icu":
      return {
        kind: "changed-in-icu",
        baseline: baseline(value.baseline),
        shown: sighting(value.shown),
      };
    default:
      throw new CalendarCodecError("invalid-copy");
  }
}

export function encodeIcuCopy(copy: IcuCopy): string {
  return JSON.stringify(copy);
}

export function decodeWeekDelivery(json: string): WeekDelivery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CalendarCodecError("invalid-delivery");
  }
  const value = object(parsed, "invalid-delivery");
  if (value.kind === "waiting-for-first-approve") return { kind: "waiting-for-first-approve" };
  if (value.kind !== "approved") throw new CalendarCodecError("invalid-delivery");
  return {
    kind: "approved",
    firstSetWeeks: weeks(value.firstSetWeeks),
    approvedWeeks: weeks(value.approvedWeeks),
  };
}

export function encodeWeekDelivery(delivery: WeekDelivery): string {
  return JSON.stringify(delivery);
}

function ticked(value: unknown): TickedChange {
  const json = object(value, "invalid-delivery");
  return {
    planWorkoutId: text(json.planWorkoutId, "invalid-delivery"),
    eventId: integer(json.eventId, "invalid-delivery"),
    dateKey: integer(json.dateKey, "invalid-delivery"),
    fingerprint: text(json.fingerprint, "invalid-delivery"),
  };
}

export function decodeCloseChoice(json: string): AthleteChangesChoice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CalendarCodecError("invalid-delivery");
  }
  const value = object(parsed, "invalid-delivery");
  if (value.kind === "keep-them") return { kind: "keep-them" };
  if (value.kind !== "remove-them" || !Array.isArray(value.ticked)) {
    throw new CalendarCodecError("invalid-delivery");
  }
  return { kind: "remove-them", ticked: value.ticked.map(ticked) };
}

export function encodeCloseChoice(choice: AthleteChangesChoice): string {
  return JSON.stringify(choice);
}
