---
"@enduragent/kernel": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: A wellness day that leaves out weight, resting heart rate, heart-rate variability, or sleep is no longer skipped.

`WellnessDaySchema` required `weight`, `restingHR`, `hrv`, `sleepSecs` and `sleepQuality` to be present, so a day that omitted one failed to parse and was dropped. The five keys now default to `null`. First of six changes for #1130.
