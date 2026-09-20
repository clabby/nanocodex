# Preference-aware thread routing

The default routing strategy is `direct`. At initial admission, one Jev request chooses a supported model **and thinking level**. Subsequent turns reuse the persisted choice; changes in later messages do not reroute the thread. The Rust agent loop and provider transports remain the same.

## Configuration

```json
{
  "configuration": {
    "model_routing": {
      "strategy": "direct",
      "preferences": {
        "completion": 60,
        "cost": 25,
        "duration": 15,
        "text": "Prefer inexpensive execution for routine work; prioritize correctness for difficult changes.",
        "target_cost_usd": 1,
        "target_duration_seconds": 120
      },
      "min_confidence": 0.75
    }
  }
}
```

Numeric preferences are relative importance weights from 0 to 100, not probabilities or percentages of traffic. Higher completion weight favors successful task completion; higher cost weight favors economy; higher duration weight favors shorter elapsed task time. Omitted preferences can be inferred by Jev from the opening prompt or optional preference text. Explicit numeric settings take precedence over conflicting text. The router does not use keyword matching to infer preferences.

Cost and duration targets are soft planning targets. They do not impose a spending cap or runtime deadline, and the PoC does not guarantee them. Missing cost/time observations remain unknown. Subscription API-equivalent cost is not cash billed to the subscription. Successful completion means independently verified task success, not merely reaching an agent terminal state.

The default eligible catalog has 15 choices: GLM-5.3 and the existing Astra, Sol, Terra and Luna ChatGPT models, each at low, medium and high thinking. Other OSS models require verified transport and capability support before admission; this is not the entire Cloudflare catalog. To restrict the choices, pass `candidates` containing exact IDs, for example:

```json
{
  "candidates": [
    "@cf/zai-org/glm-5.3:low",
    "@cf/zai-org/glm-5.3:medium",
    "gpt-6-astra:high"
  ]
}
```

Candidate eligibility and output validity are enforced in code. Invalid, unavailable or low-confidence Jev decisions use a fallback within the eligible set. The configured frontier model/effort is preferred if eligible. No fallback can escape the allowlist. Unsupported opening modalities filter out the text-only GLM route; oversized inputs use the bounded fallback path. A positive measured success threshold fails admission when its evidence requirements are unmet.

## What Jev receives and decides

One request contains the opening task, candidate identities and profiles, explicit preferences, optional preference text, versioned published eval references and supplied local measurements. Typed Choice questions return a candidate and a diagnostic task family. The category is evidence context, not a hardcoded family-to-model lookup. Candidate confidence is routing confidence, not predicted task success.

Published eval scores are priors from different harnesses, not comparable Nanocodex completion rates. The router must not invent Sol/Terra/Luna prices or relative performance where measurements are absent. Candidate selection remains provisional without a representative held-out dataset. Record actual task success, full-run cost including failures, elapsed duration, model, thinking and harness version; evaluate routing against fixed-model and evidence-only baselines.

The route's audit record retains the parsed policy, preferences, eligible IDs, chosen candidate and confidence. The settings and route are committed atomically. Restart and concurrent admission reuse that record. A restart before the initial commit may repeat classification.

`strategy: "legacy"` retains the earlier task-family policy and its measured cost/success and duration/success scoring. Earlier reports describe that strategy, not the new default. `oss_thinking` and `frontier_thinking` do not constrain the direct catalog; use `candidates` to constrain effort. The frontier pair still selects the preferred fallback.

## Design references

- [Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/): typed Choice, Score and Noul evaluation in one request.
- [ReflexRoute](https://github.com/AIGNLAI/ReflexRoute): direct Jev choice using model priors and historical outcomes.
- [RouteLLM](https://github.com/lm-sys/RouteLLM): calibrating cost/quality tradeoffs on representative queries.
- [Jev routing experiment](https://github.com/TokenTrim/jev-routing-experiment): retrieval evidence and an evidence-only ablation; Jev's incremental benefit must be tested.

The feature remains opt-in behind NANOCODEX_THREAD_ROUTING and the AI binding. There is no deployment in this PR.
