# I18n

Shared language choices and formatting conventions for athlete-facing coaching.

## Language

**Language**:
The closed set of tags lives in the contract, handwritten, because the contract is the one package everything depends on and the one that may depend on nothing.

**Locale**:
Locale comes from the surface hint and only falls back to `describeLanguage(tag).defaultLocale` when the host supplies none; the resolution records which.
