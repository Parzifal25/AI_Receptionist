# Agent Runtime — Performance Baseline (Phase 2)

**Measured:** 2026-09-15, `npm run perf:baseline` (Node v22.22.2, WSL2), 300
turns per scenario, in-memory fakes, **scripted model with 0 ms latency**.
No live LLM provider was available in the measurement environment, so the
model column measures adapter overhead only. These numbers isolate what the
runtime adds on top of provider latency; they are not an end-to-end target.

| Scenario | total p50 ms | total p95 ms | context ms | retrieval ms | model ms | actions ms | validation ms | model calls | tool rounds | prompt chars | ~tokens | reply chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| short conversation, no knowledge | 1.75 | 2.32 | 0.20 | 0.02 | 1.24 | 0.00 | 0.08 | 1 | 0 | 4939 | 1235 | 105 |
| typical FAQ (6 snippets, 16-message window) | 1.93 | 2.77 | 0.28 | 0.03 | 1.34 | 0.00 | 0.05 | 1 | 0 | 11151 | 2788 | 105 |
| long conversation (40 fetched, recap active) | 1.83 | 2.50 | 0.18 | 0.03 | 1.36 | 0.00 | 0.05 | 1 | 0 | 10763 | 2691 | 105 |
| one tool round (2 model calls) | 3.39 | 4.72 | 0.35 | 0.03 | 2.60 | 0.21 | 0.04 | 2 | 1 | 7834 | 1959 | 105 |

("~tokens" is prompt chars ÷ 4, an approximation; providers report real
counts in `UsageMetadata` at run time.)

## Findings

- **Runtime overhead is negligible**: under 2 ms p50 per turn end to end with
  a zero-latency model, under 5 ms with a tool round. Context building,
  validation, memory and persistence plumbing are not where latency comes
  from.
- **The largest contributor to real latency will be the model call itself**,
  driven by prompt size: a typical grounded turn sends ~11 k characters
  (~2.8 k tokens) of system prompt — roughly 40 % knowledge (6 × up to 1200
  chars), 35 % doctrine/rules, the rest business facts and state. On the
  CPU-hosted Ollama default this dominates (the previous audit measured
  multi-second completions); on hosted APIs it is typically 1–4 s.
- **Model calls per turn**: 1 for an ordinary turn; +1 per tool round (max 2);
  +1 for a corrective regeneration (bounded to 1); the scheduling engine and
  lead extraction add their own JSON-mode calls exactly as before Phase 2.
- **Context is stationary**: the 40-message conversation costs the same as
  the 20-message one because history is windowed to 16 and the recap is
  bounded to 1200 chars.

## Largest levers (not implemented — recorded for later phases)

1. Knowledge budget: the default 7200-char knowledge budget is the biggest
   single prompt component; a per-agent budget or score threshold would cut
   tokens directly (Phase 3 retrieval work).
2. Doctrine size: the situation/rules doctrine is ~3.5 k chars; per-agent-type
   doctrine could shrink it.
3. Prompt caching on providers that support it (OpenAI/Anthropic cache
   breakpoints) — the stable prefix (identity, facts, doctrine, rules) is
   ~70 % of the prompt.
4. Streaming to the channel: exists at the adapter level; the web route stays
   JSON because validation runs on the whole reply.

## How to re-measure

```bash
npm run perf:baseline                     # 0 ms scripted model
MODEL_LATENCY_MS=800 npm run perf:baseline  # simulate a hosted model
PERF_TURNS=1000 npm run perf:baseline
```

Per-turn timings are also emitted in production on every `message_sent`
usage event (`latencyMs`, `modelLatencyMs`, `modelCalls`, `toolRounds`,
tokens when the provider reports them) so a real-provider baseline can be
read from `usage_events` once deployed.
