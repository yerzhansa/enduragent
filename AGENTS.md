# Enduragent

The Enduragent product repository: the Mac desktop app, the `cycling-coach` and `enduragent` npm packages, the Telegram bot, and the shared coach engine and training-metric code.

# Git and pull requests

- Format commits as Conventional Commits: `<type>(<scope>): <description>`. Example: `feat(core): add rate limit retry with backoff`.
- Format branches as `<type>/<kebab-slug>` using a full-word type, lowercase letters, and fewer than 50 characters. Example: `feature/date-helpers-extraction`.
- Every task branches off the latest `origin/main`. Delete the branch after merge.
- One PR = one concern = one squash commit.
- Open every PR you create as a draft.
- Mark a PR ready only after the review gate, UI QA, and required checks pass on the final snapshot.
- Squash-merge single-PR tasks to `main` once required checks, any operator-requested ship loop, and applicable approval requirements are satisfied.
- Require explicit operator approval in the chat before merging each Version Packages, release, workflow, or release-tooling PR in `yerzhansa/enduragent`.
- Treat approval of a specific Version Packages or release PR in `yerzhansa/enduragent` as authorization to merge it and publish its release.
- Obtain renewed approval if subsequent changes alter the release behavior or security settings of an approved Version Packages or release PR in `yerzhansa/enduragent`.
- Require passing CI and repository review before merging a release PR.
- Blanket approval does not count for release PRs. Approve each one by number.
- Epic: `epic/<kebab-slug>` off `origin/main`. Children base on the epic branch, never `main`, and squash-merge into it.
- Open the umbrella PR from `epic/<slug>` to `main` as a draft when creating the epic branch.
- Before umbrella review, merge `origin/main` into the epic branch and run root `pnpm check` plus the full test suite.
- Never merge an umbrella PR without operator approval. Merge it with a merge commit. Never squash it.
- In a stacked PR sequence, never delete a parent branch while another PR depends on it.
- After merging stacked PR A, retarget PR B to `main`, merge B, and then delete both branches.
- Add a changeset with `pnpm exec changeset` for every user-visible change.
- Write `User-facing:` as one or two plain sentences an athlete understands. Do not use code names or implementation details.
- Omit `User-facing:` from infra-only changesets.
- Store issues in `docs/issues/`, one file per issue, named `<NNN>-<kebab-slug>.md`.
- Determine the next issue ID by scanning existing issue files.
- Never create GitHub issues or run `gh issue create`.
- Never close a GitHub issue, including with `gh issue close`, without explicit human approval.
- Cross-reference local issues as `[#NNN](./NNN-slug.md)`. Do not use labels.

# Pull request review and UI QA gate

- Apply this gate only to changes submitted in a PR.
- Review the diff with `.agents/skills/code-review-and-quality/SKILL.md` after implementation and focused tests pass.
- Exercise every affected user-visible flow in the running application when the diff changes UI presentation or behavior.
- Complete at most ten correction cycles for in-scope blockers found by review, UI QA, tests, or CI after initial review.
- Count each correction batch and its required rechecks as one correction cycle.
- Count correction cycles across all tasks and agents working on the same PR.
- Record the completed correction-cycle count before starting another cycle.
- Keep every correction within the operator-approved behavior and security boundaries.
- Run focused tests after each correction batch before repeating the review.
- Repeat the review once on each corrected snapshot and its affected code.
- Repeat UI QA for every affected user-visible flow after each correction cycle.
- Stop correcting and reviewing once the current snapshot passes required tests, CI, review, and UI QA.
- Leave the PR unmerged when blockers remain after ten correction cycles.
- Obtain explicit operator approval before starting a eleventh correction cycle.
- Apply repository review triggers, exemptions, sequencing, correction limits, and rationale destinations over reusable skill defaults.
- Apply the `Review guidelines` section of this file in every review.

## Review guidelines

- Prioritize correctness, privacy, security, and user-visible behavior regressions over style-only feedback.
- Treat missing tests or missing verification for changed behavior as review findings when the change is not obviously mechanical.
- For athlete-facing changes, verify that a changeset exists and includes a `User-facing:` line when users should see the release note.
- Watch fixtures, logs, and test data for real athlete identifiers or current-era dates that could expose private training data.
- Check public language and metric names against the `Repository hygiene` requirements.
