export type CoachTextBasis =
  | { readonly kind: "waiting-for-match" }
  | { readonly kind: "decided"; readonly key: string };

export type CoachText =
  | { readonly kind: "not-written" }
  | { readonly kind: "writing"; readonly startedFor: string }
  | { readonly kind: "kept"; readonly writtenFor: string }
  | { readonly kind: "failed"; readonly startedFor: string };

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
  | { readonly type: "writing-failed" };

export type CoachTextEffect =
  | { readonly kind: "none" }
  | { readonly kind: "write"; readonly for: string };

export interface CoachTextStep {
  readonly text: CoachText;
  readonly effect: CoachTextEffect;
}

export type CoachTextMarker =
  | { readonly kind: "current" }
  | { readonly kind: "written-for-another-match"; readonly writtenFor: string };

export const COACH_TEXT_NOT_WRITTEN: CoachText = Object.freeze({ kind: "not-written" });

const NONE: CoachTextEffect = Object.freeze({ kind: "none" });

function stay(text: CoachText): CoachTextStep {
  return { text, effect: NONE };
}

function startWriting(key: string): CoachTextStep {
  return { text: { kind: "writing", startedFor: key }, effect: { kind: "write", for: key } };
}

export function coachTextStep(text: CoachText, event: CoachTextEvent): CoachTextStep {
  switch (event.type) {
    case "athlete-opens":
      if (event.basis.kind !== "decided") return stay(text);
      if (text.kind === "not-written" || text.kind === "failed") {
        return startWriting(event.basis.key);
      }
      return stay(text);
    case "match-decided":
      if (event.basis.kind !== "decided" || event.page !== "open") return stay(text);
      return text.kind === "not-written" ? startWriting(event.basis.key) : stay(text);
    case "athlete-asks-again":
      if (event.basis.kind !== "decided") return stay(text);
      return text.kind === "kept" || text.kind === "failed"
        ? startWriting(event.basis.key)
        : stay(text);
    case "writing-finished":
      return text.kind === "writing"
        ? stay({ kind: "kept", writtenFor: text.startedFor })
        : stay(text);
    case "writing-failed":
      return text.kind === "writing"
        ? stay({ kind: "failed", startedFor: text.startedFor })
        : stay(text);
  }
}

export function coachTextMarker(text: CoachText, basis: CoachTextBasis): CoachTextMarker {
  if (text.kind !== "kept") return { kind: "current" };
  if (basis.kind === "decided" && basis.key === text.writtenFor) return { kind: "current" };
  return { kind: "written-for-another-match", writtenFor: text.writtenFor };
}
