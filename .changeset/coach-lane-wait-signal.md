---
"@enduragent/coach": patch
"@enduragent/coach-client": patch
---

The coach logs `store_lane_wait` with the RPC method and the wait in milliseconds when a call waits more than 5 s for the store lane, including a sync taking the lane back after an intervals.icu request. When a window connection closes while calls are still running, the coach logs `rpc_connection_closed_with_calls_running` with the close code, the number of running calls and, when one call's abort ended the connection, that call's method. The coach client now sends the aborted call's method as the close reason. Refs docs/issues/393.
