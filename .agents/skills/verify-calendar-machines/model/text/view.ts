export const title = "The coach's text for one Activity or one missed workout";
export const state = (v: any) => {
  const t = v.text === "none" ? (v.match === "pending" ? "Facts only, waiting for your match" : "Not written yet")
    : v.text === "writing" ? "Writing (1 reply)"
    : v.text === "failed" ? "Could not write, Try again"
    : v.writtenFor === v.match ? "Kept" : v.marker ? "Kept, marked: written for an earlier match" : "Kept, describing an old match";
  return t;
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "YouOpen": return "you open it";
    case "YouLeave": return null;
    case "YouDecideTheMatch": return "you press Confirm or Not this one";
    case "YouChangeTheMatchLater": return "you change the match later";
    case "WritingFinishes": return "the coach finishes";
    case "WritingFails": return "the model cannot be reached";
    case "YouPressWriteAgain": return t.text === "writing" && f.text === "failed" ? "you press Try again" : "you press Write again";
    case "ModelChanges": return null;
  }
  return a;
};
export const group = (v: any) => (v.text === "kept" ? "done" : v.text === "writing" ? "spending" : "free");
export const colors = { done: "teal", spending: "purple", free: "blue" };
