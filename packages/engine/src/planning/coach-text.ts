export type CoachTextMatch =
  | { readonly kind: "no-workout" }
  | { readonly kind: "workout"; readonly planWorkoutId: string };

export type CoachTextBasis =
  | { readonly kind: "waiting-for-match" }
  | { readonly kind: "decided"; readonly match: CoachTextMatch };

export type CoachTextFailure = "model" | "interrupted";

export type CoachText =
  | { readonly kind: "not-written" }
  | { readonly kind: "writing"; readonly startedFor: CoachTextMatch }
  | { readonly kind: "kept"; readonly writtenFor: CoachTextMatch }
  | {
      readonly kind: "failed";
      readonly startedFor: CoachTextMatch;
      readonly failedBy: CoachTextFailure;
    };

export type CoachTextPage = "open" | "closed";

export type CoachTextEvent =
  | { readonly type: "athlete-opens"; readonly basis: CoachTextBasis }
  | {
      readonly type: "match-decided";
      readonly basis: CoachTextBasis;
      readonly page: CoachTextPage;
    }
  | { readonly type: "athlete-asks-again"; readonly basis: CoachTextBasis }
  | { readonly type: "writing-finished" }
  | { readonly type: "writing-failed" }
  | { readonly type: "writing-abandoned" };

export type CoachTextEffect =
  | { readonly kind: "none" }
  | { readonly kind: "write"; readonly for: CoachTextMatch };

export interface CoachTextStep {
  readonly text: CoachText;
  readonly effect: CoachTextEffect;
}

export type CoachTextMarker =
  | { readonly kind: "current" }
  | { readonly kind: "written-for-another-match"; readonly writtenFor: CoachTextMatch };

export const COACH_TEXT_NOT_WRITTEN: CoachText = Object.freeze({ kind: "not-written" });

const NONE: CoachTextEffect = Object.freeze({ kind: "none" });

export function sameCoachTextMatch(left: CoachTextMatch, right: CoachTextMatch): boolean {
  if (left.kind === "no-workout" || right.kind === "no-workout") return left.kind === right.kind;
  return left.planWorkoutId === right.planWorkoutId;
}

function stay(text: CoachText): CoachTextStep {
  return { text, effect: NONE };
}

function startWriting(match: CoachTextMatch): CoachTextStep {
  return { text: { kind: "writing", startedFor: match }, effect: { kind: "write", for: match } };
}

export function coachTextStep(text: CoachText, event: CoachTextEvent): CoachTextStep {
  switch (event.type) {
    case "athlete-opens":
      if (event.basis.kind !== "decided") return stay(text);
      if (
        text.kind === "not-written" ||
        (text.kind === "failed" && text.failedBy === "interrupted")
      ) {
        return startWriting(event.basis.match);
      }
      return stay(text);
    case "match-decided":
      if (event.basis.kind !== "decided" || event.page !== "open") return stay(text);
      return text.kind === "not-written" ? startWriting(event.basis.match) : stay(text);
    case "athlete-asks-again":
      if (event.basis.kind !== "decided") return stay(text);
      return text.kind === "kept" || text.kind === "failed"
        ? startWriting(event.basis.match)
        : stay(text);
    case "writing-finished":
      return text.kind === "writing"
        ? stay({ kind: "kept", writtenFor: text.startedFor })
        : stay(text);
    case "writing-failed":
    case "writing-abandoned":
      return text.kind === "writing"
        ? stay({
            kind: "failed",
            startedFor: text.startedFor,
            failedBy: event.type === "writing-failed" ? "model" : "interrupted",
          })
        : stay(text);
  }
}

export function coachTextMarker(text: CoachText, basis: CoachTextBasis): CoachTextMarker {
  if (text.kind !== "kept") return { kind: "current" };
  if (basis.kind === "decided" && sameCoachTextMatch(basis.match, text.writtenFor)) {
    return { kind: "current" };
  }
  return { kind: "written-for-another-match", writtenFor: text.writtenFor };
}
