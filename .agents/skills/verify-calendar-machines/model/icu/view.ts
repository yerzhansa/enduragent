const athlete = (x: string) => x === "E" || x === "gone";
export const title = "A Plan Workout on intervals.icu";
export const state = (v: any) => {
  let copy: string;
  if (v.card === "open") copy = "Card: Keep or Put back?";
  else if (v.icu !== v.base) copy = "Changed in intervals.icu, not seen yet";
  else if (athlete(v.plan)) copy = "Your version, kept";
  else if (v.icu === (v.plan === "P" ? "Pn" : "Qn")) copy = "On intervals.icu, as planned";
  else copy = "Approved change, not sent yet";
  const change = v.prop === "none" ? "No coach change" : v.flag ? "Coach change, marked: replaces your edit" : "Coach change waiting";
  return { "intervals.icu copy": copy, "Coach change": change };
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "AppRuns": return t.card === "open" ? "the app sees the change" : "the app sends the Plan's version";
    case "AthleteChangesIt": return t.icu === t.base ? "you change it back" : "you edit or delete it in intervals.icu";
    case "CardRefreshes": return t.card === "none" ? "the card closes, you changed it back" : "the card shows your newest version";
    case "Keep": return "you press Keep";
    case "PutBack": return "you press Put back";
    case "CoachProposes": return "the coach proposes a change";
    case "ChangeSetRefreshes": return "the Change Set updates to your version";
    case "Approve": return "you approve";
    case "ApproveKeepMine": return "you approve, keeping yours";
    case "UpdateApproved": return "you approve the update's Change Set";
  }
  return a;
};
export const group = (v: any) => (v.card === "open" || v.icu !== v.base ? "waits" : "settled");
export const colors = { waits: "orange", settled: "teal" };
