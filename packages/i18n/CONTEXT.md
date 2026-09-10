# I18n

Shared language choices and formatting conventions for athlete-facing coaching.

## Language

**Language**:
The closed set of tags lives in the contract, handwritten, because the contract is the one package everything depends on and the one that may depend on nothing.

**Locale**:
Locale comes from the surface hint and only falls back to `describeLanguage(tag).defaultLocale` when the host supplies none; the resolution records which.

**Catalog**:
The named messages in one supported language, grouped by the part of the app they describe.

**Phrasebook**:
A catalog language paired with a locale for translating messages and formatting dates, numbers, lists, and relative days.

**Message**:
A catalog key and its substitution values, ready for a phrasebook to render in the athlete's language.

**Glossary**:
A term list pairing English training terms with their recommended wording in one supported language.

**Behind**:
A translation whose English source has changed since it was translated.

## Glossaries

The 16 non-English glossaries provide shared training vocabulary for catalog translation and native review. Each contains the recommended terms for one language, including regional differences.
