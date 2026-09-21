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
      "min_confidence": 0.75,
      "low_confidence_fallback": "proposed"
    }
  }
}
```

Numeric preferences are relative importance weights from 0 to 100, not probabilities or percentages of traffic. Higher completion weight favors successful task completion; higher cost weight favors economy; higher duration weight favors shorter elapsed task time. Omitted preferences can be inferred by Jev from the opening prompt or optional preference text. Explicit numeric settings take precedence over conflicting text. The router does not use keyword matching to infer preferences.

Cost and duration targets are soft planning targets. They do not impose a spending cap or runtime deadline, and the PoC does not guarantee them. Missing cost/time observations remain unknown. Subscription API-equivalent cost is not cash billed to the subscription. Successful completion means independently verified task success, not merely reaching an agent terminal state.

The catalog has up to 45 provider/model/effort choices. The 15 native choices are GLM-5.3 and the existing Astra, Sol, Terra and Luna ChatGPT models, each at low, medium and high thinking. Configured OpenRouter and Vercel transports each add the same 15 model/effort choices; unavailable providers are excluded before Jev. Other OSS models require verified transport and capability support before admission; this is not the entire Cloudflare catalog. To restrict the choices, pass `candidates` containing exact IDs, for example:

```json
{
  "candidates": [
    "@cf/zai-org/glm-5.3:low",
    "@cf/zai-org/glm-5.3:medium",
    "gpt-6-astra:high"
  ]
}
```

Candidate eligibility and output validity are enforced in code. In policy version `jev-direct-v3`, `min_confidence` remains 0.75 by default. With the default proposed setting, the threshold labels uncertainty rather than preventing use of a valid proposal. A valid but lower-confidence proposal uses `selection: "fallback"`, with no measured estimate. The default `low_confidence_fallback: "proposed"` retains that eligible proposal so an uncertain economy choice is not silently replaced with the configured frontier model. This is a policy fallback, not increased confidence, calibration, or a guarantee that Jev interpreted the preference correctly. Even zero reported confidence remains a fallback under this setting. Set `low_confidence_fallback: "frontier"` for the previous conservative replacement behavior. This setting affects the direct strategy only.

Invalid, unavailable, malformed, or missing Jev output always uses the conservative eligible fallback, regardless of this setting. The configured frontier model/effort is preferred if eligible, then an eligible ChatGPT candidate, then the first eligible candidate. This deterministic ordering is not a measured quality ranking. No fallback can escape the allowlist. Unsupported opening modalities filter out the text-only GLM route; oversized inputs use the bounded fallback path. A positive measured success threshold fails admission when its evidence requirements are unmet.

## What Jev receives and decides

One request contains the opening task, candidate identities and profiles, explicit preferences, optional preference text, versioned published eval references and supplied local measurements. Typed Choice questions return a candidate and a diagnostic task family. The category is evidence context, not a hardcoded family-to-model lookup. Candidate confidence is routing confidence, not predicted task success.

Published eval scores are priors from different harnesses, not comparable Nanocodex completion rates. The router must not invent Sol/Terra/Luna prices or relative performance where measurements are absent. The 45 candidates are not interchangeable: thinking levels change reasoning effort and provider routes can differ in price, latency and availability. Their probabilities are not summed to manufacture confidence. Candidate selection remains provisional without a representative held-out dataset. Record actual task success, full-run cost including failures, elapsed duration, model, thinking and harness version; evaluate routing against fixed-model and evidence-only baselines.

The route's audit record retains the parsed policy, preferences, eligible IDs, proposed and chosen candidates, raw confidence, `confidence_status` and `fallback_basis`. `fallback_basis: valid_proposal` distinguishes retaining an uncertain valid proposal from `eligible_frontier` replacement; `none` identifies an accepted-confidence selection. The settings and route are committed atomically. Restart and concurrent admission reuse that record. A restart before the initial commit may repeat classification.

`strategy: "legacy"` retains the earlier task-family policy and its measured cost/success and duration/success scoring. Earlier reports describe that strategy, not the new default. `oss_thinking` and `frontier_thinking` do not constrain the direct catalog; use `candidates` to constrain effort. The frontier pair still selects the preferred fallback.

## Design references

- [Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/): typed Choice, Score and Noul evaluation in one request.
- [ReflexRoute](https://github.com/AIGNLAI/ReflexRoute): direct Jev choice using model priors and historical outcomes.
- [RouteLLM](https://github.com/lm-sys/RouteLLM): calibrating cost/quality tradeoffs on representative queries.
- [Jev routing experiment](https://github.com/TokenTrim/jev-routing-experiment): retrieval evidence and an evidence-only ablation; Jev's incremental benefit must be tested.

The feature remains opt-in behind NANOCODEX_THREAD_ROUTING and the AI binding. There is no deployment in this PR.

## Child threads and provider transport

If `multi_agent.enabled` is true, a new child is routed independently with the same policy and current provider availability. Its role/task and any explicit model/thinking overrides determine its eligible choices. The child decision is saved before inference, reused on continuation/reconstruction, and authorized against the retained spawning-turn context. The root decision stays unchanged. Missing authorization or route metadata fails closed.

See [provider configuration](AGGREGATOR_ROUTING.md) and [completion/validation report](THREAD_ROUTING_FINISH_2026_09_21.md). Mixed-provider trees use stateless HTTP and full history replay; OpenRouter/Vercel routes need their deployment-owned secrets. Transport telemetry records outcomes, but unknown execution locations do not become regional performance evidence.
