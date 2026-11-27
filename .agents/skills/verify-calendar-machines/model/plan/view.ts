export const title = "End Plan and Replace Plan";
export const state = (v: any) => {
  if (v.old === "active") return (v.confirm ? "Confirm: end the Plan?" : v.repl === "review" ? "Making a replacement" : "Plan running") + (v.editedW === "there" ? ", one workout changed by you" : "");
  const keep = v.editedW === "there" ? ", your changed workout kept" : "";
  const ic = v.cleanup === "running" ? "removing workouts from tomorrow on"
    : v.cleanup === "failed" ? "removal failed, Retry"
    : v.cleanup === "verified" ? "workouts removed" : "nothing to remove";
  if (v.repl === "active") return v.newSent ? `New Plan running, on intervals.icu${keep}` : `New Plan running, ${ic}`;
  return `Plan ended, ${ic}${v.cleanup === "verified" ? keep : ""}`;
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "YouPressEnd": return "you press End Plan";
    case "YouCancel": return "you cancel";
    case "YouConfirmEnd": return "you confirm";
    case "CleanupWorks": return "the removal works";
    case "CleanupFails": return "intervals.icu does not answer";
    case "YouStartReplacing": return "you press Replace Plan";
    case "YouApproveReplacement": return "you approve the new Plan";
    case "NewPlanGoesOut": return "the new Plan's weeks go out";
    case "RaceDayPasses": return "race day passes";
    case "YouEditAFutureWorkout": return "you change a later workout in intervals.icu and keep it";
    case "Done": return null;
  }
  return a;
};
export const group = (v: any) => (v.old === "active" ? "running" : v.cleanup === "failed" ? "attention" : "closing");
export const colors = { running: "teal", attention: "orange", closing: "blue" };
