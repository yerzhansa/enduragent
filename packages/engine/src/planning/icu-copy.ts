export interface IcuVersion {
  readonly fingerprint: string;
  readonly updated: string;
}

export type IcuSighting =
  | {
      readonly kind: "present";
      readonly eventId: number;
      readonly dateKey: number;
      readonly version: IcuVersion;
    }
  | { readonly kind: "absent" };

export type IcuCopyOwner = "plan" | "athlete-edit";

export interface IcuBaseline {
  readonly eventId: number;
  readonly dateKey: number;
  readonly planFingerprint: string;
  readonly readBack: IcuVersion;
  readonly owner: IcuCopyOwner;
}

export type IcuCopy =
  | { readonly kind: "not-sent" }
  | { readonly kind: "on-icu"; readonly baseline: IcuBaseline }
  | {
      readonly kind: "changed-in-icu";
      readonly baseline: IcuBaseline;
      readonly shown: IcuSighting;
    }
  | { readonly kind: "removed-by-you" };

export type IcuPlanSide =
  | { readonly kind: "send"; readonly planFingerprint: string }
  | { readonly kind: "withdraw" };

export type IcuCopyEffect =
  | { readonly kind: "none" }
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly eventId: number; readonly expected: IcuVersion }
  | { readonly kind: "delete"; readonly eventId: number; readonly expected: IcuVersion }
  | {
      readonly kind: "adopt-into-plan";
      readonly eventId: number;
      readonly dateKey: number;
      readonly version: IcuVersion;
    }
  | { readonly kind: "remove-from-plan" };

export interface IcuCopyDecision {
  readonly copy: IcuCopy;
  readonly effect: IcuCopyEffect;
}

export type IcuCopyChoiceResult =
  | ({ readonly kind: "done" } & IcuCopyDecision)
  | ({ readonly kind: "refreshed" } & IcuCopyDecision)
  | { readonly kind: "no-card"; readonly copy: IcuCopy };

export interface IcuWriteReceipt {
  readonly eventId: number;
  readonly dateKey: number;
  readonly planFingerprint: string;
  readonly readBack: IcuVersion;
}

export type ChangeSetMark = "plain" | "replaces-your-edit";

export interface ChangeSetTargetView {
  readonly basis: string;
  readonly mark: ChangeSetMark;
}

export type ChangeSetTargetApproval =
  | { readonly kind: "approve"; readonly mark: ChangeSetMark }
  | { readonly kind: "refresh"; readonly view: ChangeSetTargetView };

export const ICU_COPY_NOT_SENT: IcuCopy = Object.freeze({ kind: "not-sent" });

const NONE: IcuCopyEffect = Object.freeze({ kind: "none" });

function decision(copy: IcuCopy, effect: IcuCopyEffect = NONE): IcuCopyDecision {
  return { copy, effect };
}

export function sameSighting(left: IcuSighting, right: IcuSighting): boolean {
  if (left.kind === "absent" || right.kind === "absent") return left.kind === right.kind;
  return left.eventId === right.eventId && left.version.fingerprint === right.version.fingerprint;
}

function matchesBaseline(baseline: IcuBaseline, sighting: IcuSighting): boolean {
  return (
    sighting.kind === "present" &&
    sighting.eventId === baseline.eventId &&
    sighting.version.fingerprint === baseline.readBack.fingerprint
  );
}

function withFreshToken(baseline: IcuBaseline, sighting: IcuSighting): IcuBaseline {
  if (sighting.kind !== "present" || sighting.version.updated === baseline.readBack.updated) {
    return baseline;
  }
  return { ...baseline, readBack: { ...baseline.readBack, updated: sighting.version.updated } };
}

function decideInSync(baseline: IcuBaseline, plan: IcuPlanSide): IcuCopyDecision {
  const copy: IcuCopy = { kind: "on-icu", baseline };
  if (plan.kind === "withdraw") {
    return decision(copy, {
      kind: "delete",
      eventId: baseline.eventId,
      expected: baseline.readBack,
    });
  }
  if (plan.planFingerprint === baseline.planFingerprint) return decision(copy);
  return decision(copy, {
    kind: "update",
    eventId: baseline.eventId,
    expected: baseline.readBack,
  });
}

function decideNotSent(plan: IcuPlanSide, sighting: IcuSighting): IcuCopyDecision {
  if (sighting.kind === "absent") {
    return plan.kind === "send"
      ? decision(ICU_COPY_NOT_SENT, { kind: "create" })
      : decision(ICU_COPY_NOT_SENT);
  }
  if (plan.kind === "withdraw") {
    return decision(ICU_COPY_NOT_SENT, {
      kind: "delete",
      eventId: sighting.eventId,
      expected: sighting.version,
    });
  }
  return decision({
    kind: "on-icu",
    baseline: {
      eventId: sighting.eventId,
      dateKey: sighting.dateKey,
      planFingerprint: plan.planFingerprint,
      readBack: sighting.version,
      owner: "plan",
    },
  });
}

export function icuCopyOnRun(
  copy: IcuCopy,
  plan: IcuPlanSide,
  sighting: IcuSighting,
): IcuCopyDecision {
  switch (copy.kind) {
    case "removed-by-you":
      return decision(copy);
    case "not-sent":
      return decideNotSent(plan, sighting);
    case "on-icu": {
      if (matchesBaseline(copy.baseline, sighting)) {
        return decideInSync(withFreshToken(copy.baseline, sighting), plan);
      }
      if (sighting.kind === "absent" && plan.kind === "withdraw") {
        return decision(ICU_COPY_NOT_SENT);
      }
      return decision({ kind: "changed-in-icu", baseline: copy.baseline, shown: sighting });
    }
    case "changed-in-icu": {
      if (matchesBaseline(copy.baseline, sighting)) {
        return icuCopyOnRun({ kind: "on-icu", baseline: copy.baseline }, plan, sighting);
      }
      if (sameSighting(copy.shown, sighting)) return decision(copy);
      return decision({ ...copy, shown: sighting });
    }
  }
}

function recheck(
  copy: IcuCopy,
  current: IcuSighting,
):
  | { readonly kind: "ready"; readonly card: Extract<IcuCopy, { kind: "changed-in-icu" }> }
  | Exclude<IcuCopyChoiceResult, { kind: "done" }> {
  if (copy.kind !== "changed-in-icu") return { kind: "no-card", copy };
  if (matchesBaseline(copy.baseline, current)) {
    return { kind: "refreshed", ...decision({ kind: "on-icu", baseline: copy.baseline }) };
  }
  if (!sameSighting(copy.shown, current)) {
    return { kind: "refreshed", ...decision({ ...copy, shown: current }) };
  }
  return { kind: "ready", card: copy };
}

export function icuCopyKeep(
  copy: IcuCopy,
  current: IcuSighting,
  adoptedPlanFingerprint: string,
): IcuCopyChoiceResult {
  const checked = recheck(copy, current);
  if (checked.kind !== "ready") return checked;
  const shown = checked.card.shown;
  if (shown.kind === "absent") {
    return { kind: "done", ...decision({ kind: "removed-by-you" }, { kind: "remove-from-plan" }) };
  }
  return {
    kind: "done",
    ...decision(
      {
        kind: "on-icu",
        baseline: {
          eventId: shown.eventId,
          dateKey: shown.dateKey,
          planFingerprint: adoptedPlanFingerprint,
          readBack: shown.version,
          owner: "athlete-edit",
        },
      },
      {
        kind: "adopt-into-plan",
        eventId: shown.eventId,
        dateKey: shown.dateKey,
        version: shown.version,
      },
    ),
  };
}

export function icuCopyPutBack(copy: IcuCopy, current: IcuSighting): IcuCopyChoiceResult {
  const checked = recheck(copy, current);
  if (checked.kind !== "ready") return checked;
  const shown = checked.card.shown;
  if (shown.kind === "absent")
    return { kind: "done", ...decision(checked.card, { kind: "create" }) };
  return {
    kind: "done",
    ...decision(checked.card, { kind: "update", eventId: shown.eventId, expected: shown.version }),
  };
}

export function icuCopyWritten(copy: IcuCopy, receipt: IcuWriteReceipt): IcuCopy {
  if (copy.kind === "removed-by-you") return copy;
  return {
    kind: "on-icu",
    baseline: {
      eventId: receipt.eventId,
      dateKey: receipt.dateKey,
      planFingerprint: receipt.planFingerprint,
      readBack: receipt.readBack,
      owner: "plan",
    },
  };
}

export function icuCopyDeleted(copy: IcuCopy): IcuCopy {
  return copy.kind === "removed-by-you" ? copy : ICU_COPY_NOT_SENT;
}

export function icuCopyAllowsMove(copy: IcuCopy): boolean {
  return copy.kind !== "changed-in-icu" && copy.kind !== "removed-by-you";
}

export function icuCopyIsAthleteChange(copy: IcuCopy): boolean {
  return (
    copy.kind === "changed-in-icu" ||
    (copy.kind === "on-icu" && copy.baseline.owner === "athlete-edit")
  );
}

function basis(copy: IcuCopy, planFingerprint: string): string {
  switch (copy.kind) {
    case "not-sent":
    case "removed-by-you":
      return `${copy.kind}|${planFingerprint}`;
    case "on-icu":
      return `${copy.kind}|${planFingerprint}|${copy.baseline.owner}|${copy.baseline.readBack.fingerprint}`;
    case "changed-in-icu":
      return `${copy.kind}|${planFingerprint}|${copy.baseline.owner}|${copy.shown.kind === "present" ? copy.shown.version.fingerprint : "absent"}`;
  }
}

export function changeSetTargetView(copy: IcuCopy, planFingerprint: string): ChangeSetTargetView {
  return {
    basis: basis(copy, planFingerprint),
    mark:
      (copy.kind === "on-icu" || copy.kind === "changed-in-icu") &&
      copy.baseline.owner === "athlete-edit"
        ? "replaces-your-edit"
        : "plain",
  };
}

export function changeSetTargetApproval(
  shown: ChangeSetTargetView,
  copy: IcuCopy,
  planFingerprint: string,
): ChangeSetTargetApproval {
  const current = changeSetTargetView(copy, planFingerprint);
  if (current.basis !== shown.basis || current.mark !== shown.mark) {
    return { kind: "refresh", view: current };
  }
  return { kind: "approve", mark: current.mark };
}
