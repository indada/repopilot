# Post-merge tracking and Agent evaluation

These features extend a verified goal beyond draft-PR publication. They are opt-in and do not merge or deploy code.

## Track a merged goal

Configure checks that must succeed on the merge commit:

```json
{
  "iteration": {
    "postMerge": {
      "requiredChecks": ["test"],
      "requireIssueClosed": true
    }
  }
}
```

Run one inspection explicitly or include it in the normal iteration loop:

```sh
npm run dev -- goals track GOAL_ID --config config.local.json
npm run dev -- iterate --once --config config.local.json
```

The controller verifies that the PR still belongs to the goal's owned branch and target branch. An open PR is `waiting_for_merge`. After merge, required checks are read from the merge commit: incomplete checks produce `observing`, all configured checks with a `success` conclusion and an optionally closed source Issue produce `healthy`, and missing or failed checks produce `regressed`. A PR closed without merge is `closed_unmerged`.

The latest check evidence, merge SHA, Issue state and reasons are stored atomically in the goal. Terminal results are not polled again automatically. A post-merge regression is exposed by `discover`, where the existing preview/token/apply flow can create a deduplicated Issue for maintainer review. It does not automatically authorize that Issue for execution.

## Define repeatable evaluation cases

Add an evaluation identity to a normal goal specification:

```json
{
  "evaluation": {
    "suite": "core-maintenance",
    "case": "bounded-pagination",
    "profile": "codex-default"
  }
}
```

`suite` identifies the fixed task set, `case` identifies one task, and `profile` identifies the model/prompt/controller configuration being compared. Each value uses a lowercase identifier of up to 40 characters. Keep the goal objective, acceptance criteria, repository commit and runner image fixed when comparing profiles.

Generate a deterministic JSON report from local goal evidence:

```sh
npm run dev -- evals --suite core-maintenance --config config.local.json
```

The report includes a task fingerprint plus each case's outcome, completed steps, rounds, model calls, reported tokens and elapsed time. Per-profile aggregates include completion, verification, publication and observed post-merge pass rates. `digest` covers normalized results without random goal IDs, while `evidenceDigest` also binds the report to the exact stored goal records. Duplicate `suite/profile/case` keys and suite cases whose pinned commit or goal definition differ across profiles are listed explicitly instead of being hidden.

Evaluation is evidence aggregation, not a model-generated score. It does not claim that unmerged work is production-safe, and post-merge health only covers the configured GitHub checks and Issue state.

## Replay a pinned suite and gate a strategy

The development line after 1.5.0 supports a suite manifest with an explicit repository, branch and 40-character commit SHA for each case. The case specification contains title, objective, mode, acceptance criteria and allowed paths; it cannot contain a live Issue, branch override or evaluation identity. For example:

```json
{
  "schemaVersion": 1,
  "repository": "owner/repo",
  "suite": "core-maintenance",
  "cases": [{
    "id": "negative-quantity",
    "branch": "main",
    "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "spec": {
      "title": "Reject negative quantities",
      "objective": "Reject a negative quantity before saving an order.",
      "mode": "bugfix",
      "acceptance": [{ "id": "negative", "text": "Negative quantities must produce a validation error." }],
      "allowedPaths": ["src", "test"]
    }
  }]
}
```

Replace the sample SHA with the actual pinned commit. Replay the same manifest with two configuration profiles, retaining the same `dataDir` for evidence comparison. It runs the normal bounded goal pipeline and forces publishing off, even when the supplied configuration enables publication. Repeating a replay resumes the matching goal; changing a case under the same suite/profile is rejected.

```sh
npm run dev -- evals replay --spec suite.json --profile baseline --config baseline.json
npm run dev -- evals replay --spec suite.json --profile candidate --config candidate.json
npm run dev -- evals gate --suite core-maintenance --baseline baseline --candidate candidate --config candidate.json
```

`evals gate` exits with failure when either profile is missing cases, case inputs differ, evidence is duplicated, a baseline-verified case regresses, the candidate misses the configured verification rate, call/token/time costs exceed limits, or the candidate's recorded configuration differs from the current controller configuration (with publishing disabled for replay). The comparison binds the decision to stored evidence; it does not run or promote a model by itself. Configure thresholds and optional `iterate` admission with:

```json
{
  "iteration": {
    "strategyGate": {
      "suite": "core-maintenance",
      "baselineProfile": "baseline",
      "candidateProfile": "candidate",
      "minCases": 3,
      "minVerificationRate": 0.9,
      "maxCallsRatio": 1.5,
      "maxTokensRatio": 1.5,
      "maxElapsedRatio": 2
    }
  }
}
```

When `strategyGate` is configured, `iterate` checks it before advancing new Issue candidates. A failed gate defers new reproduction and automatic approval; already approved or running candidates can still resume. Manual candidate approval and maintainer review remain separate decisions.
