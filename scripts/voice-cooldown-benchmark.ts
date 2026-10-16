/** W4.6: actual router with seeded synthetic cooldown and scripted providers. */
import { performance } from "node:perf_hooks";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { AppError } from "@halo/core/errors/app-error";
import { ScriptedLLM, reply } from "../tests/mocks/runtime-fakes";
async function main() {
  const results: Record<string, unknown> = {};
  for (const skip of [false, true]) {
    const values: number[] = [];
    for (let i = 0; i < 10; i++) {
      const cooldowns = new Map([['primary', { until: Date.now()+30, strikes: 1, error: AppError.provider('synthetic cooldown', { category: 'rate_limit' }) }]]);
      const router = new FallbackLLMRouter([{ model:'synthetic', provider:new ScriptedLLM([reply('okay')], undefined, 'primary') }, { model:'synthetic', provider:new ScriptedLLM([reply('okay')], undefined, 'secondary') }], { cooldowns });
      const start = performance.now();
      await router.complete('synthetic', [], { timeoutMs: 1000, ...(skip ? { maxCooldownWaitMs: 0 } : {}) });
      values.push(performance.now()-start);
    }
    values.sort((a,b) => a-b);
    results[skip ? 'voiceSkip' : 'waitControl'] = { n:10, p50:values[4], p95:values[8], max:values[9] };
  }
  console.log(JSON.stringify({ evidence:'local test; actual router; synthetic 30ms cooldown; no provider calls', results }, null, 2));
}
void main();
