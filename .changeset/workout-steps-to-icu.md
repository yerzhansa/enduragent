---
"@enduragent/coach": minor
"@enduragent/engine": minor
"@enduragent/sport-cycling": minor
"@enduragent/desktop": minor
---

User-facing: intervals.icu now shows each Plan workout's steps and load when it has your FTP, so your head unit gets watts for every step. Without an FTP in intervals.icu, workouts go there as before, with no steps.

The Chat calendar mirror writes each workout's description at send time from its stored `content`, as step lines in % of FTP, and only while the one FTP is known. A "Warmup" line heads a warm-up step and a "Cooldown" line a cool-down step; both are intervals.icu syntax and stay in English in every locale, like "3x". The text is part of the send fingerprint, so an FTP appearing or being removed rewrites the workouts in the two-week window once. Athlete edits are still never overwritten, and a past workout keeps what intervals.icu has. A workout matched to a ride keeps its text there when only the text would change. A coach change to its day, name, sport or length still goes out, with the current text. When the steps are removed, intervals.icu keeps the load and intensity it computed from them. Rows without `content` keep any stored description unchanged.
