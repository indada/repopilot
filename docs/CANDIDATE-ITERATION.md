# Evidence-driven candidate iteration

The development line after 1.5.0 adds a local candidate queue. It records possible work from trusted, labeled GitHub Issues, required CI failures on RepoPilot-owned PRs, trusted review comments, error-severity policy findings, structured baseline failures and post-merge regressions. Discovery only records evidence and priority reasons; it does not grant permission to edit code.

```sh
npm run dev -- candidates refresh --config config.local.json
npm run dev -- candidates list --config config.local.json
npm run dev -- candidates show CANDIDATE_ID --config config.local.json
npm run dev -- candidates reproduce CANDIDATE_ID --config config.local.json
npm run dev -- candidates approve CANDIDATE_ID --expected EVIDENCE_DIGEST --config config.local.json
npm run dev -- candidates run CANDIDATE_ID --config config.local.json
```

An Issue candidate requires `iteration.queue` with nonempty `labels`, `trustedAuthors` and `allowedPaths`, plus an enabled Codex Agent and structured test runner. Its reproduction runs against the pinned target commit with publishing disabled. Codex may add tests within the configured paths; the original tests must pass, the missing behavior must fail with stable structured test identities twice, and no production repair is requested during this step. An Issue with the configured `featureLabel` uses new-behavior tests; other Issues use regression tests. Approval requires the exact evidence digest shown by `candidates show`. `run` rechecks the open Issue, trusted author, required labels, target SHA and stored reproduction report before creating one bounded goal. Repeated execution resumes the linked goal instead of claiming a second one. The normal goal verification and optional draft-PR publication rules still apply.

`iterate` now uses the same candidate state machine as the manual commands. Each cycle refreshes trusted Issue evidence and advances at most `queue.maxPerRun` candidates. By default it performs reproduction and waits for explicit approval. Set `queue.autoApprove=true` in the trusted controller configuration only when you want a stable, trusted, labeled Issue to continue automatically through goal verification and optional draft-PR publication. Existing configurations without this setting now stop after reproduction; direct Issue-to-goal polling no longer bypasses the gate. `strategyGate` defers new reproduction and automatic approval when its fixed-case comparison fails, while previously approved or running candidates can resume. Operator-paused goals stay paused during polling.

Candidate advancement is serialized by the existing per-data-directory controller lock. Unexpected candidate errors retain a failure count and exponential retry time; `queue.maxFailures` (default 3) blocks further automatic attempts, while a changed evidence digest resets that count. Unreproduced behavior and exhausted goal budgets remain blocked without polling retries. A crash after a goal is saved can recover the linked candidate without creating another goal. Editing an Issue after it has a goal cannot grant a fresh goal budget.

CI, policy, baseline and post-merge candidates can be reproduced as evidence, but they cannot directly create a goal. A maintainer must express the requested behavior and scope in a trusted Issue. Review prose is recorded as feedback and remains inconclusive until it becomes a testable Issue. This prevents a check name, log line or comment from silently becoming code-change authority.

Candidate records live under `dataDir/candidates` and are written atomically under the controller lock. `list` and `show` are available while another run holds the lock. Refresh marks removed or changed evidence stale and clears prior approval; a stale candidate must be revalidated before approval unless its Issue already has a goal. Identical pinned evidence can reuse its saved reproduction report. Priority affects processing order, never authorization. No candidate automatically merges or deploys code.

For fixed-case strategy comparison, see [post-merge tracking and evaluation](POST-MERGE-EVALUATION.md).
