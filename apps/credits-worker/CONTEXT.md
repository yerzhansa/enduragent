# Credits worker

Leave `KEY_COUNT_CEILING` unset. Worker configuration, the direct management client, and the proof CLI reject configured ceilings before provider requests. Global key-count enforcement is deferred until an atomic enforcement mechanism is implemented and verified.

Inventory and count operations remain read-only observations. They do not enforce a quota. The default guardrail mode remains `after_create`.

Bulk operator spend reports mark ledger-owned keys absent from the completed provider inventory with `missingRemoteKey: true`. These rows retain ledger grants, refunds, and identity. Provider balances, usage, credits remaining, and disabled state are `null`. Other rows have `missingRemoteKey: false`. Failed or incomplete inventory requests fail the entire report. Single-athlete requests still fetch the provider key and fail if it is unavailable.
