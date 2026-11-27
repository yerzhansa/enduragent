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
  | { readonly kind: "not-sent"; readonly owner: IcuCopyOwner }
  | { readonly kind: "on-icu"; readonly baseline: IcuBaseline }
  | {
      readonly kind: "moving-by-you";
      readonly baseline: IcuBaseline;
      readonly planFingerprint: string;
    }
  | {
      readonly kind: "changed-in-icu";
      readonly baseline: IcuBaseline;
      readonly shown: IcuSighting;
    }
  | { readonly kind: "removed-by-you" }
  | { readonly kind: "kept-as-yours"; readonly eventId: number };

export type IcuPlanSide =
  | { readonly kind: "send"; readonly planFingerprint: string }
  | { readonly kind: "withdraw"; readonly reason: IcuWithdrawReason };

export type IcuWithdrawReason = "not-in-plan" | "not-due";

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

export const ICU_COPY_NOT_SENT: IcuCopy = Object.freeze({ kind: "not-sent", owner: "plan" });

export const UNKNOWN_PLAN_FINGERPRINT = "unknown";

const NONE: IcuCopyEffect = Object.freeze({ kind: "none" });

function decision(copy: IcuCopy, effect: IcuCopyEffect = NONE): IcuCopyDecision {
  return { copy, effect };
}

export function sameSighting(left: IcuSighting, right: IcuSighting): boolean {
  if (left.kind === "absent" || right.kind === "absent") return left.kind === right.kind;
  return (
    left.eventId === right.eventId &&
    left.dateKey === right.dateKey &&
    left.version.fingerprint === right.version.fingerprint
  );
}

function matchesBaseline(baseline: IcuBaseline, sighting: IcuSighting): boolean {
  return (
    sighting.kind === "present" &&
    sighting.eventId === baseline.eventId &&
    sighting.dateKey === baseline.dateKey &&
    sighting.version.fingerprint === baseline.readBack.fingerprint
  );
}

function withFreshToken(baseline: IcuBaseline, sighting: IcuSighting): IcuBaseline {
  if (sighting.kind !== "present" || sighting.version.updated === baseline.readBack.updated) {
    return baseline;
  }
  return { ...baseline, readBack: { ...baseline.readBack, updated: sighting.version.updated } };
}

function decideMove(
  copy: Extract<IcuCopy, { kind: "moving-by-you" }>,
  plan: IcuPlanSide,
): IcuCopyDecision {
  const expected = { eventId: copy.baseline.eventId, expected: copy.baseline.readBack };
  if (
    plan.kind === "withdraw" &&
    plan.reason === "not-in-plan" &&
    copy.baseline.owner === "athlete-edit"
  ) {
    return decision({ kind: "kept-as-yours", eventId: copy.baseline.eventId });
  }
  if (plan.kind === "withdraw") return decision(copy, { kind: "delete", ...expected });
  if (plan.planFingerprint !== copy.planFingerprint) {
    return decideInSync(copy.baseline, plan);
  }
  return decision(copy, { kind: "update", ...expected });
}

function decideInSync(baseline: IcuBaseline, plan: IcuPlanSide): IcuCopyDecision {
  const copy: IcuCopy = { kind: "on-icu", baseline };
  if (baseline.owner === "athlete-edit") {
    return plan.kind === "withdraw" && plan.reason === "not-in-plan"
      ? decision({ kind: "kept-as-yours", eventId: baseline.eventId })
      : decision(copy);
  }
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

function decideNotSent(
  copy: Extract<IcuCopy, { kind: "not-sent" }>,
  plan: IcuPlanSide,
  sighting: IcuSighting,
): IcuCopyDecision {
  if (sighting.kind === "absent") {
    return plan.kind === "send" ? decision(copy, { kind: "create" }) : decision(copy);
  }
  if (plan.kind === "withdraw") return decision(copy);
  return decideInSync(
    {
      eventId: sighting.eventId,
      dateKey: sighting.dateKey,
      planFingerprint: UNKNOWN_PLAN_FINGERPRINT,
      readBack: sighting.version,
      owner: copy.owner,
    },
    plan,
  );
}

export function icuCopyOnRun(
  copy: IcuCopy,
  plan: IcuPlanSide,
  sighting: IcuSighting,
): IcuCopyDecision {
  switch (copy.kind) {
    case "removed-by-you":
    case "kept-as-yours":
      return decision(copy);
    case "not-sent":
      return decideNotSent(copy, plan, sighting);
    case "moving-by-you": {
      if (matchesBaseline(copy.baseline, sighting)) {
        return decideMove({ ...copy, baseline: withFreshToken(copy.baseline, sighting) }, plan);
      }
      return decision({ kind: "changed-in-icu", baseline: copy.baseline, shown: sighting });
    }
    case "on-icu": {
      if (matchesBaseline(copy.baseline, sighting)) {
        return decideInSync(withFreshToken(copy.baseline, sighting), plan);
      }
      if (sighting.kind === "absent" && plan.kind === "withdraw" && plan.reason === "not-in-plan") {
        return decision({ kind: "not-sent", owner: copy.baseline.owner });
      }
      return decision({ kind: "changed-in-icu", baseline: copy.baseline, shown: sighting });
    }
    case "changed-in-icu": {
      if (matchesBaseline(copy.baseline, sighting)) {
        return icuCopyOnRun({ kind: "on-icu", baseline: copy.baseline }, plan, sighting);
      }
      if (sighting.kind === "absent" && plan.kind === "withdraw" && plan.reason === "not-in-plan") {
        return decision({ kind: "not-sent", owner: copy.baseline.owner });
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
  plan: IcuPlanSide,
  adoptedPlanFingerprint: string,
): IcuCopyChoiceResult {
  const checked = recheck(copy, current);
  if (checked.kind !== "ready") return checked;
  const shown = checked.card.shown;
  if (plan.kind === "withdraw" && plan.reason === "not-in-plan") {
    return {
      kind: "done",
      ...decision(
        shown.kind === "absent"
          ? { kind: "not-sent", owner: checked.card.baseline.owner }
          : { kind: "kept-as-yours", eventId: shown.eventId },
      ),
    };
  }
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

export function icuCopyPutBack(
  copy: IcuCopy,
  current: IcuSighting,
  plan: IcuPlanSide,
): IcuCopyChoiceResult {
  const checked = recheck(copy, current);
  if (checked.kind !== "ready") return checked;
  const shown = checked.card.shown;
  if (plan.kind === "withdraw") {
    if (shown.kind === "absent")
      return {
        kind: "done",
        ...decision({ kind: "not-sent", owner: checked.card.baseline.owner }),
      };
    return {
      kind: "done",
      ...decision(checked.card, {
        kind: "delete",
        eventId: shown.eventId,
        expected: shown.version,
      }),
    };
  }
  if (shown.kind === "absent")
    return { kind: "done", ...decision(checked.card, { kind: "create" }) };
  return {
    kind: "done",
    ...decision(checked.card, { kind: "update", eventId: shown.eventId, expected: shown.version }),
  };
}

export function icuCopyWritten(copy: IcuCopy, receipt: IcuWriteReceipt): IcuCopy {
  if (copy.kind === "removed-by-you" || copy.kind === "kept-as-yours") return copy;
  const kept = copy.kind === "not-sent" ? copy.owner : copy.baseline.owner;
  return {
    kind: "on-icu",
    baseline: {
      eventId: receipt.eventId,
      dateKey: receipt.dateKey,
      planFingerprint: receipt.planFingerprint,
      readBack: receipt.readBack,
      owner: kept,
    },
  };
}

export function icuCopyDeleted(copy: IcuCopy): IcuCopy {
  if (copy.kind === "removed-by-you" || copy.kind === "kept-as-yours") return copy;
  if (copy.kind === "not-sent") return copy;
  return { kind: "not-sent", owner: copy.baseline.owner };
}

export function icuCopyAllowsMove(copy: IcuCopy): boolean {
  return dragAllowed(copy);
}

function dragAllowed(
  copy: IcuCopy,
): copy is Extract<IcuCopy, { kind: "not-sent" | "on-icu" | "moving-by-you" }> {
  return copy.kind === "not-sent" || copy.kind === "on-icu" || copy.kind === "moving-by-you";
}

export function icuCopyDrag(copy: IcuCopy, draggedPlanFingerprint: string): IcuCopy | null {
  if (!dragAllowed(copy)) return null;
  if (copy.kind === "not-sent") return copy;
  return {
    kind: "moving-by-you",
    baseline: copy.baseline,
    planFingerprint: draggedPlanFingerprint,
  };
}

export function icuCopyChangeApproved(copy: IcuCopy, mark: ChangeSetMark): IcuCopy {
  if (mark !== "replaces-your-edit") return copy;
  if (copy.kind === "removed-by-you") return ICU_COPY_NOT_SENT;
  if (copy.kind === "not-sent") return ICU_COPY_NOT_SENT;
  if (
    (copy.kind === "on-icu" || copy.kind === "moving-by-you" || copy.kind === "changed-in-icu") &&
    copy.baseline.owner === "athlete-edit"
  ) {
    return { ...copy, baseline: { ...copy.baseline, owner: "plan" } };
  }
  return copy;
}

function ownedByAthlete(copy: IcuCopy): boolean {
  if (copy.kind === "not-sent") return copy.owner === "athlete-edit";
  return (
    (copy.kind === "on-icu" || copy.kind === "moving-by-you" || copy.kind === "changed-in-icu") &&
    copy.baseline.owner === "athlete-edit"
  );
}

export function icuCopyIsAthleteChange(copy: IcuCopy): boolean {
  return copy.kind === "changed-in-icu" || ownedByAthlete(copy);
}

function sightingKey(sighting: IcuSighting): string {
  return sighting.kind === "absent"
    ? "absent"
    : `${sighting.eventId}@${sighting.dateKey}:${sighting.version.fingerprint}`;
}

function basis(copy: IcuCopy, planFingerprint: string): string {
  switch (copy.kind) {
    case "not-sent":
      return `${copy.kind}|${copy.owner}|${planFingerprint}`;
    case "removed-by-you":
      return `${copy.kind}|${planFingerprint}`;
    case "kept-as-yours":
      return `${copy.kind}|${copy.eventId}|${planFingerprint}`;
    case "moving-by-you":
      return `${copy.kind}|${planFingerprint}|${copy.planFingerprint}|${copy.baseline.owner}|${copy.baseline.eventId}@${copy.baseline.dateKey}:${copy.baseline.readBack.fingerprint}`;
    case "on-icu":
      return `${copy.kind}|${planFingerprint}|${copy.baseline.owner}|${copy.baseline.eventId}@${copy.baseline.dateKey}:${copy.baseline.readBack.fingerprint}`;
    case "changed-in-icu":
      return `${copy.kind}|${planFingerprint}|${copy.baseline.owner}|${sightingKey(copy.shown)}`;
  }
}

export function changeSetTargetView(copy: IcuCopy, planFingerprint: string): ChangeSetTargetView {
  return {
    basis: basis(copy, planFingerprint),
    mark: copy.kind === "removed-by-you" || ownedByAthlete(copy) ? "replaces-your-edit" : "plain",
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
