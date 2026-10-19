# Jev decision layer (1.7.0)

RepoPilot 1.7.0 adds an optional controller-side Jev decision layer for trusted Issue intake. Codex continues to plan, generate tests, review and propose repairs through the OpenAI Codex SDK. Jev supplies bounded judgments before automatic intake; independent tests and the existing controller policy still decide what can execute or publish.

Jev is a TypeSafe model with typed Choice, Score and Noul outputs. This integration uses the [official HTTP API](https://docs.typesafe.ai/api) at `https://api.typesafe.ai/v1/systemone`, with no additional runtime dependency. It defaults to the pinned `jev-1.13.0` model. See TypeSafe's [models](https://docs.typesafe.ai/models) and [confidence](https://docs.typesafe.ai/confidence) documentation. Rolling aliases are intentionally rejected so cached decisions have an explicit model version.

## Configuration

The feature is disabled when `decision` is absent or `enabled=false`. Add this section to the trusted controller configuration, or adapt the full [Jev service example](../examples/jev-service.json):

```json
{
  "decision": {
    "enabled": false,
    "provider": "jev",
    "model": "jev-1.13.0",
    "mode": "shadow",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "timeoutSeconds": 10,
    "maxInputBytes": 12000,
    "minConfidence": 0.85,
    "minTestableProbability": 0.9,
    "maxRisk": "low",
    "maxAttempts": 3,
    "retrySeconds": 60,
    "limits": {
      "dailyCalls": 100,
      "dailyTokens": 500000,
      "tokensPerCall": 16000
    }
  }
}
```

Configure `iteration.queue`, trusted Issue authors, required labels and allowed paths first. Set the environment variable named by `apiKeyEnv` using your secret manager, then enable the feature. Keep the key out of repository files, configuration values, logs and Agent containers. Changing the key requires restarting the controller. `doctor` checks only whether it is present; it does not authenticate or call Jev. `OPENAI_API_KEY` remains the separate Codex credential.

The example leaves Agent review, repair, decision calls and publishing disabled. Enable only the capabilities you intend to use. This is a hosted TypeSafe API integration; the model itself does not run on the local worker. It sends Issue text to an additional provider when enabled.

## What Jev decides

One request asks four independent questions against the same bounded state:

| Question | Typed result | Use in RepoPilot |
| --- | --- | --- |
| Requested work | Choice: bugfix, feature, question or unclear | Compare with the intent selected by the trusted Issue-label policy |
| Change risk | Choice: low, medium, high or unknown | Suggest human review when risk exceeds configured tolerance |
| Stated urgency | Score from 0 to 3, with rubric and probabilities | Inspectable advice; does not reorder the trusted queue |
| Testable request | Noul: probability from 0 to 1 | Flag missing observable acceptance criteria |

The state contains repository identity, Issue number, pinned commit/branch, candidate/evidence IDs, title, complete bounded request and allowed paths. Source credentials, repository file contents and test logs are not sent by this adapter. Issue eligibility is checked before transmission and again after evaluation. A changed author, label, request or target commit invalidates the candidate before it can advance.

The controller validates the actual returned model, answer types, allowed options, complete probability distributions, Choice confidence consistency, Score rubric/mean and numeric usage. Unexpected fields cannot become commands. Responses have a 64 KiB limit, timeouts propagate cancellation, and redirects are rejected. Raw provider error bodies and transport error text are not persisted or printed.

## Shadow and gate modes

`shadow` is the default. It records the result or a bounded failure while preserving the existing intake flow. An unavailable provider or unfavorable judgment does not change the existing reproduction and approval policy. Storage/accounting failures still stop advancement; they are not treated as successful fallbacks.

`gate` adds restrictions to **new automatic intake** through `iterate` and `serve`. A candidate continues only when request classification matches the label-selected intent, both Choice confidences meet `minConfidence`, risk is within `maxRisk`, and the testability probability meets `minTestableProbability`. Low confidence, unknown/high risk, malformed responses, provider failure and exhausted decision budgets leave the candidate available for human review. They do not spend candidate failure retries or trip the service verification circuit.

A favorable judgment cannot approve a candidate, establish a passing test, change allowed paths, change feature/bugfix intent, waive the strategy gate or authorize publication. `queue.autoApprove` retains its independent meaning: only explicitly configured automatic approval can follow stable reproduction. Already-approved or running candidates retain their existing bounded recovery path without a new admission decision.

For a deferred Issue, inspect the decision and refine the Issue if the acceptance or scope is unclear. A maintainer can also explicitly run `candidates reproduce`, inspect the resulting evidence, approve its exact digest and run the candidate. Those manual commands retain all existing verification, authorization and publication checks; the model is not an authorization source.

The configured thresholds are conservative starting values, not measured accuracy or reliability guarantees. Evaluate on your own Issue descriptions before switching from shadow to gate. Urgency and confidence are model judgments, not verification evidence.

## Inspect and retry

```sh
node dist/cli.js decisions status --config config.local.json
node dist/cli.js decisions list --config config.local.json --limit 20
node dist/cli.js decisions show DECISION_ID --config config.local.json
node dist/cli.js decisions evaluate CANDIDATE_ID --config config.local.json
node dist/cli.js decisions retry DECISION_ID --expected INPUT_DIGEST --config config.local.json
```

Portable users can use `./repopilot` or `.\repopilot.cmd` instead of `node dist/cli.js`. `list`, `show` and `status` work while the controller holds its writer lock. `evaluate` and `retry` mutate evidence and require the exclusive lock; stop a running controller before using them. Evaluate requires an existing current trusted Issue candidate and an enabled decision provider, but runs no Codex repair or test job. A `review` recommendation is still an evaluated result; inspect its route separately from command success.

Retry clears a failed/deferred record's backoff using the exact inspected input digest. It preserves attempts, daily consumption and all candidate/goal budgets. Exhausted attempt allowances cannot be reset by retry. Fix credentials or configuration before permitting another attempt. The next `evaluate`/`iterate`/`serve` performs the bounded evaluation; the retry command itself makes no model call.

## Evidence, recovery and budgets

Records live under `dataDir/decisions`. Identity binds the complete structured input digest, pinned model and controller-owned question version. Records retain typed answers, actual model, usage, timestamps, attempts and failure codes; they do not duplicate Issue prose or provider secrets. Candidate inspection includes the current decision summary. An unchanged evaluated input reuses its result, including after restart. Threshold changes recompute the recommendation without another provider call. New source evidence or a different pinned model gets a new decision identity.

Decision settings are excluded from execution configuration identity. Enabling this admission layer, changing thresholds or raising an operational limit does not replenish an existing goal or invalidate its pinned verification evidence. Execution policy, runner and Agent changes retain their normal identity checks.

Jev has a separate persistent UTC daily ledger. `dailyCalls` and `dailyTokens` apply to Jev; the existing `service.limits` apply to Codex execution. The two ledgers are not a shared currency or billing cap. Local missing-key/oversized-input preflight failures make no request and consume no call allowance. Before dispatch, the controller reserves one call and `tokensPerCall`; actual validated input/output usage replaces that reservation. Usage above the reservation is charged in full. A timeout, crash or invalid reply retains the reservation. New calls stop if the next reservation will not fit. A late response is charged to its original UTC day.

Repeated input coalesces through serial decision admission. Failures retain bounded attempts and exponential service scheduling with provider `Retry-After` respected; the adapter itself never blindly retries a POST. An interrupted running record is recovered as uncertain, with a delay before retry and no refund of unknown usage. Cached review decisions do not starve later candidates under `queue.maxPerRun`. Operator service pause interrupts active evaluation. Decision-budget deferral resumes when a new UTC day or a deliberately raised allowance permits admission.
