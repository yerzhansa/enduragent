#!/bin/sh
# One command for the verify-coach-change skill. Run from anywhere:
#   sh .agents/skills/verify-coach-change/scripts/check.sh
# It checks every rule of model/CoachChange.tla with TLC (one run per rule)
# and runs scripts/summary-model-check.ts on the real runtime-config.ts, then
# compares each result with expected-results.txt. Exit 0 means every rule
# holds or breaks exactly as recorded there. Any difference exits 1.
set -eu

skill=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$skill/../../.." && pwd)
model="$skill/model"
work=$(mktemp -d "${TMPDIR:-/tmp}/verify-coach-change.XXXXXX")
trap 'rm -rf "$work"' EXIT

# TLC 1.7.4, pinned by checksum. Java 25 (Temurin) through mise, or $JAVA.
tlc_version=1.7.4
tlc_sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
cache="${XDG_CACHE_HOME:-$HOME/.cache}/enduragent-verify"
jar="$cache/tla2tools-$tlc_version.jar"
mkdir -p "$cache"
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
if [ ! -f "$jar" ] || [ "$(sha256 "$jar")" != "$tlc_sha256" ]; then
  curl -fsSL -o "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$tlc_version/tla2tools.jar"
  if [ "$(sha256 "$jar.part")" != "$tlc_sha256" ]; then
    echo "tla2tools.jar checksum mismatch" >&2
    exit 2
  fi
  mv "$jar.part" "$jar"
fi
if [ -z "${JAVA:-}" ]; then
  mise=$(command -v mise || echo "$HOME/.local/bin/mise")
  if [ ! -x "$mise" ]; then
    echo "Need Java 11 or later: install mise (https://mise.jdx.dev) or set JAVA" >&2
    exit 2
  fi
  "$mise" install --quiet java@temurin-25 >/dev/null
  JAVA=$("$mise" which java --tool java@temurin-25)
fi

results="$work/results.txt"
: > "$results"

# TLC: one run per rule, so each rule gets its own verdict.
constants=$(sed -n '1,/^INVARIANTS/p' "$model/CoachChange.cfg" | sed '$d')
rules=$(sed -n '/^INVARIANTS/,$p' "$model/CoachChange.cfg" | sed '1d' | awk 'NF { print $1 }')
cp "$model/CoachChange.tla" "$work/"
for rule in $rules; do
  printf '%s\nINVARIANT %s\nCHECK_DEADLOCK FALSE\n' "$constants" "$rule" > "$work/$rule.cfg"
  (cd "$work" && "$JAVA" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 \
    -metadir "$work/meta-$rule" -config "$rule.cfg" CoachChange.tla > "$work/$rule.out" 2>&1) || true
  if grep -q "Invariant $rule is violated" "$work/$rule.out"; then
    echo "CoachChange $rule breaks" >> "$results"
  elif grep -q "No error has been found" "$work/$rule.out"; then
    echo "CoachChange $rule holds" >> "$results"
  else
    echo "CoachChange $rule error" >> "$results"
    sed -n '1,40p' "$work/$rule.out" >&2
  fi
done
printf '%s\nINVARIANT TypeOK\n' "$constants" > "$work/deadlock.cfg"
(cd "$work" && "$JAVA" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 \
  -metadir "$work/meta-deadlock" -config deadlock.cfg CoachChange.tla > "$work/deadlock.out" 2>&1) || true
if grep -q "Deadlock reached" "$work/deadlock.out"; then
  echo "CoachChange NoDeadlock breaks" >> "$results"
elif grep -q "No error has been found" "$work/deadlock.out"; then
  echo "CoachChange NoDeadlock holds" >> "$results"
else
  echo "CoachChange NoDeadlock error" >> "$results"
fi

# The summary and memory model check runs on the real code. It imports
# packages/core, which needs @enduragent/coach-contract built.
if [ ! -f "$repo/packages/coach-contract/dist/index.js" ]; then
  (cd "$repo" && pnpm --filter @enduragent/coach-contract build >/dev/null)
fi
(cd "$repo" && pnpm exec tsx "$skill/scripts/summary-model-check.ts") > "$work/summary.out"
sed -n 's/^RESULT /SummaryModel /p' "$work/summary.out" >> "$results"

echo "Results:"
sed 's/^/  /' "$results"
if diff -u "$skill/expected-results.txt" "$results" > "$work/diff.txt"; then
  echo "Every rule matches expected-results.txt."
  exit 0
fi
echo "Results differ from expected-results.txt:"
sed -n '3,$p' "$work/diff.txt"
echo "Paths for the summary and memory rules:"
cat "$work/summary.out"
exit 1
