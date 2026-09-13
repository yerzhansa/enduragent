# Credits worker

Leave `KEY_COUNT_CEILING` unset. Worker configuration, the direct management client, and the proof CLI reject configured ceilings before provider requests. Global key-count enforcement is deferred until an atomic enforcement mechanism is implemented and verified.

Inventory and count operations remain read-only observations. They do not enforce a quota. The default guardrail mode remains `after_create`.
