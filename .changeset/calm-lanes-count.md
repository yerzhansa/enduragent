---
"@enduragent/sync-intervals-icu": patch
"@enduragent/coach": patch
---

A reference capture now returns a report beside its records. For each of the four lanes (settings, activities, wellness, streams) the report holds the rows fetched, the rows landed, and one drop record for every fetched row that did not land. A drop record names the lane, the row's index, a checked id and date, the step that failed, the reason, and the field. It never holds a value or an error message. A recording whose download failed is listed apart, because no row arrived. The capture loop no longer skips a row without counting it, and an error in wellness landing that is not a row rejection now fails the capture. The batch field `dropped_activity_rows` is replaced by `activityDropEvidence(batch.report.activities)`. Fourth of six changes for #1130.
