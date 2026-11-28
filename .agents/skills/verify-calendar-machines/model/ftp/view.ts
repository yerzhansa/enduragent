export const title = "FTP: one number, the one in intervals.icu";
export const state = (v: any) => {
  const p = v.prop === "none" ? (v.cool ? "No proposal for 4 weeks" : "No proposal")
    : v.prop === "shown" ? "Coach proposes a new FTP"
    : v.prop === "confirm" ? "Confirm: set it in intervals.icu?"
    : "Writing to intervals.icu";
  const q = v.ask === "none" || v.ask === "done" ? "One FTP" : v.ask === "open" ? "Asked once: which FTP?" : "Two FTPs, you said later";
  return { Proposal: p, "After the update": q };
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "Evidence": return t.evidence === "test" ? "you finish a planned FTP test" : t.evidence === "drift" ? "the estimate stays 3% away for 14 days" : "one strong ride";
    case "AppChecks": return "the app checks after a sync";
    case "Quiet": return null;
    case "Keep": return "you press Keep";
    case "WeeksPass": return "4 weeks pass";
    case "Use": return "you press Use";
    case "ConfirmWrite": return t.prop === "confirm" ? "the confirm shows the new intervals.icu FTP" : "you confirm";
    case "CancelConfirm": return "you cancel";
    case "WriteWorks": return "intervals.icu saves it";
    case "WriteFails": return "intervals.icu does not answer";
    case "YouSetFtpInIcu": return "you set FTP in intervals.icu";
    case "YouSetProposedInIcu": return "you set the coach's number in intervals.icu";
    case "IcuHoldsProposal": return "intervals.icu already holds it, nothing to write";
    case "AnswerUseApp": return "you pick the app's FTP";
    case "AnswerUseIcu": return "you pick intervals.icu's FTP";
    case "AskMeLater": return "you press Ask me later";
  }
  return a;
};
export const group = (v: any) => (v.prop === "none" ? "quiet" : "asking");
export const colors = { quiet: "teal", asking: "orange" };
