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

An Issue candidate requires `iteration.queue` with nonempty `labels`, `trustedAuthors` and `allowedPaths`, plus an enabled Codex Agent and structured test runner. Its reproduction runs against the pinned target commit with publishing disabled. Codex may add tests within the configured paths; the original tests must pass, the generated regression must fail with stable structured identities twice, and no production repair is requested during this step. Approval requires the exact evidence digest shown by `candidates show`. `run` rechecks the open Issue, trusted author, required labels, target SHA and stored reproduction report before creating one bounded goal. Repeated execution resumes the linked goal instead of claiming a second one. The normal goal verification and optional draft-PR publication rules still apply.

CI, policy, baseline and post-merge candidates can be reproduced as evidence, but they cannot directly create a goal. A maintainer must express the requested behavior and scope in a trusted Issue. Review prose is recorded as feedback and remains inconclusive until it becomes a testable Issue. This prevents a check name, log line or comment from silently becoming code-change authority.

Candidate records live under `dataDir/candidates` and are written atomically under the controller lock. `list` and `show` are available while another run holds the lock. Refresh marks removed or changed evidence stale; a stale candidate must be reproduced again. Priority affects display order only. No candidate automatically merges or deploys code.

For fixed-case strategy comparison, see [post-merge tracking and evaluation](POST-MERGE-EVALUATION.md).
