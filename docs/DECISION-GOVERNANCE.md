# Decision evaluation and controlled policy iteration (1.8.0)

RepoPilot connects Jev's typed recommendations to engineering outcomes, explicit human labels, fixed-case evaluation and versioned policy changes. This workflow runs locally alongside the existing Codex verification pipeline. Offline evaluation and threshold sweeps make no model calls, and no decision or human dataset label grants code-execution, merge or deployment authority.

## Outcomes and human review

The controller retains immutable outcome observations linking a decision to its current candidate, pinned reproduction report, goal, report IDs, repair PR and post-merge status. Observations are captured at controller command completion and service/iteration boundaries. The evidence may describe successful verification or a regression; it does not automatically label the original request as safe. Historical observations remain when input changes. A goal is linked to historical decision evidence only when its pinned commit and request digest match.

```sh
./repopilot decisions outcomes --config config.local.json
./repopilot decisions outcomes DECISION_ID --config config.local.json
./repopilot decisions show DECISION_ID --config config.local.json
./repopilot decisions review DECISION_ID --expected INPUT_DIGEST --spec examples/decision-review.json --config config.local.json
./repopilot decisions requests --config config.local.json
./repopilot decisions reviews --config config.local.json
```

Replace IDs and the digest with inspected values. Review JSON requires `expectedRoute` (`continue` or `review`) and a self-declared local `reviewer` label. Optional `expectedKind`, `expectedRisk` and `testable` labels enable separate diagnostic metrics; `note` is optional. Review the complete request and relevant engineering evidence yourself. A passing test is not sufficient to label a request low-risk. Labels are local operator assertions, not verified reviewer identities.

The review command queues an immutable request and works while `serve` owns the controller lock. The controller rechecks the input and decision-evidence digests before applying it. New review revisions preserve earlier labels; they do not edit a prior revision or approve a candidate. With no controller running, apply pending requests explicitly:

```sh
./repopilot decisions process --config config.local.json
```

Service/iteration boundaries process up to 20 pending requests at a time. A queued acknowledgement means pending, not applied. `decisions requests` shows applied/rejected receipts. Crash recovery reuses the same review/transition/request identities.

## Fixed-case evaluation

Export an explicitly named suite from manually reviewed, still-matching evidence. The exported manifest pins each case's decision ID, input digest, decision-evidence digest and exact human-review revision. It contains no Issue prose or API keys. The output is created exclusively and never overwrites an existing file.

```sh
./repopilot decisions suite --suite issue-triage --output triage-suite.json --config config.local.json
./repopilot policies save --spec examples/decision-policy-shadow.json --config config.local.json
./repopilot policies save --spec examples/decision-policy-gate.json --config config.local.json
./repopilot policies list --config config.local.json
./repopilot decisions replay --spec triage-suite.json --policy POLICY_ID --config config.local.json
./repopilot decisions evaluations --config config.local.json
```

`replay` runs threshold logic over stored Jev answers and saves an immutable evaluation. It does not regenerate tests, execute a goal, contact GitHub or call a model. Only the configured pinned model and question version can be replayed; evaluating another model requires actual decisions from that model. Missing/changed decisions, labels, mismatched repositories and duplicate cases fail rather than silently substitute evidence.

Metrics include:

- Continue/review recommendations, false-allow count/rate and false-review count/rate against explicit human routes. The rate denominators are human-review cases and human-continue cases, respectively.
- Kind, risk and testability agreement for cases with those optional labels. Unlabeled dimensions are not treated as correct.
- Available decisions, observed tokens and elapsed time, plus the count of attempts with unknown usage. Missing usage is not silently replaced by zero-cost success.

Both shadow and gate policies are evaluated by their recommendations. A shadow recommendation is not a claim that execution was blocked. Replaying thresholds does not establish actual Codex-call savings or production safety. Samples are selected by operators and may be biased; include blocked and uncertain requests in human review, and use held-out examples before relying on observed rates.

The replay exits with code 1 when promotion requirements fail, but still saves and prints the evaluation for inspection. This is a valid unfavorable result, not a missing evaluation.

## Compare and sweep thresholds

```sh
./repopilot decisions compare --baseline BASELINE_EVALUATION_ID --candidate CANDIDATE_EVALUATION_ID --config config.local.json
./repopilot decisions sweep --spec triage-suite.json --policy POLICY_ID --config config.local.json
```

Comparison requires exactly the same suite, decision evidence and human-review revisions. It reports both metric sets and changed routes. A sweep checks nine combinations of confidence (`0.70`, `0.85`, `0.95`) and testability (`0.80`, `0.90`, `0.95`), keeping the pinned model, question version and risk limit unchanged. It makes zero provider calls, does not save or activate policies, and does not reset any usage ledger. Save a deliberate policy specification when you choose a candidate threshold set.

## Versioned activation and rollback

Policies are immutable versions identified by repository and complete specification. Set `decision.useManagedPolicy=true` explicitly to let saved active policies control future admission decisions. Provider model, credentials, transport and daily usage limits remain owned by trusted configuration. An active policy can change mode and thresholds, but cannot change the configured provider model or question version.

```json
{
  "decision": {
    "enabled": false,
    "useManagedPolicy": false,
    "promotion": { "minCases": 3, "maxFalseAllow": 0, "maxFalseReviewRate": 0.2 }
  }
}
```

This is a fragment. Enable the feature and managed policy only when configured deliberately. Defaults require at least three manually labeled fixed cases, coverage of both expected routes, valid evaluated answers for all cases, zero false allows and at most a 20% false-review rate. These are operating limits, not statistical guarantees.

```sh
./repopilot policies activate POLICY_ID --evaluation EVALUATION_ID --config config.local.json
./repopilot policies activate POLICY_ID --evaluation EVALUATION_ID --apply --expected PREVIEW_TOKEN --config config.local.json
./repopilot policies status --config config.local.json
./repopilot policies rollback --config config.local.json
./repopilot policies rollback --apply --expected PREVIEW_TOKEN --config config.local.json
```

First inspect the preview, then use its exact token. Both activation and rollback are queued operator requests available while the service runs. The worker rechecks repository, model, policy, promotion limits, evaluation evidence and current policy revision before applying an activation. Stale previews cannot overwrite a newer transition. A paused service can process operator requests without starting model work.

Each decision evaluation freezes its effective policy at admission; a later transition changes future recommendations. Cached answers can be reinterpreted with a new threshold without another call. Admission observations preserve the actual recommendation and policy digest used at that boundary. Already-approved goal recovery retains its previous authority and budget.

The first activation snapshots the configured baseline as an immutable policy. Rollback restores the policy preceding the most recent transition, including that original baseline; later configuration edits do not rewrite the saved baseline. The transition history remains available, and a repeated application of the same request is idempotent. Daily ledgers, decision attempts and goal budgets are never reset by a policy transition.

## Queue a decision retry while running

```sh
./repopilot decisions retry DECISION_ID --queue --expected INPUT_DIGEST --config config.local.json
```

This queues a retry request bound to the exact inspected record. The worker rejects changed evidence and exhausted original attempt limits. On success it clears backoff without replenishing attempts or consumption and wakes the matching Issue when available. Model calls still require current trust checks, applicable gates, budgets and explicit approval policy. The existing retry command without `--queue` retains its exclusive-lock behavior.

## Local read-only console

```sh
./repopilot dashboard --config config.local.json --port 8788
```

Run this in another terminal and open the complete URL printed by the command. The console is a separate process and does not acquire the controller writer lock or start model/test jobs. It shows candidate states, decision summaries, task DAG dependencies, UTC usage, active policy, event counts and operator request receipts, refreshed every five seconds. Lists are bounded to 100 entries; the CLI retains access to complete evidence and pagination.

The server binds only `127.0.0.1`, requires an independent random session token for its JSON API, checks Host/Origin, rejects cross-site requests and all non-GET methods, and serves no filesystem paths or write routes. The page uses local scripts/styles with a restrictive content security policy and renders dynamic values as text. Snapshots exclude provider credentials, raw Issue/review prose, source contents, local paths and logs. A refresh after the browser removes the URL fragment requires reopening the printed URL. Keep the local URL private and stop the process with Ctrl+C. This console is not a hosted multi-user administration service.

## Storage and upgrade

`dataDir/decision-governance` stores immutable policies, human labels, evaluations, admissions, outcome observations and operator requests/receipts. Policy state is atomically replaced with an appended transition history under the existing controller lock. Request appends can occur concurrently and are acknowledged only after durable writes. Keep this directory together with `dataDir/decisions`, candidates, goals and reports when backing up or upgrading. Do not edit stored evidence in place.

Existing 1.6.0 configurations continue to run with Jev and managed policies disabled. This release also includes the Jev integration developed for 1.7.0; no intermediate 1.7.0 installation is required. Existing legacy decision records can be reviewed and replayed. Historical goal linkage is conservative when an older record has no pinned subject metadata.
