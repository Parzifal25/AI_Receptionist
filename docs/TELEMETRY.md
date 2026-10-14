# Application telemetry foundation

HALO uses its existing JSON logger and runtime/voice events. There is no application OpenTelemetry SDK, metrics server, collector, new dependency or external account in this change. Next.js, the long-lived Node voice gateway and the Python Pipecat worker have different lifecycles. Log-derived metrics fit the existing deployment without an additional SDK lifecycle or overlapping framework. The lockfile declares optional OpenTelemetry API peers for Next and Vitest, but no application SDK/exporter. The reference deployment is Vercel for Next, with a separately hosted long-lived voice gateway/worker; an in-memory metrics registry would not provide durable cross-instance aggregation. This is a local foundation, not distributed tracing.

## Configuration and local verification

`HALO_TELEMETRY=stdout` enables newline-delimited JSON observations. Unset, `disabled`, and all unknown values disable them. This setting is independent of `LOG_LEVEL`; existing operational logs remain enabled. No URL is accepted and no telemetry network requests are made. Leave disabled in production during this rollout: hosting platforms may forward stdout themselves.

```sh
HALO_TELEMETRY=stdout npm run dev > /tmp/halo-app.log 2>&1
# In another terminal, with existing local gateway configuration:
HALO_TELEMETRY=stdout npm run voice-gateway > /tmp/halo-gateway.log 2>&1
curl -i http://localhost:3000/api/health
```

The response includes a generated `x-request-id`. Find its `correlationId` in the `telemetry` JSON record. IDs from request headers are deliberately ignored. Each Node HTTP request gets a fresh ID; nested runtime/tools/retries/bookings inherit it with AsyncLocalStorage. Voice sessions generate a separate ID, shared with their runtime turns. IDs are log fields, never metric labels. IDs do not yet propagate across the Next-to-gateway HTTP or gateway-to-Python boundaries.

Exercise synthetic local bookings and fake voice calls using the existing test fixtures (no real provider credentials required):

```sh
HALO_TELEMETRY=stdout npm test -- tests/unit/telemetry.test.ts tests/integration/voice-gateway-service.test.ts tests/integration/pipecat-gateway.test.ts --maxWorkers=2
```

Each observation contains `schema:1`, a timestamp, static event, correlation ID, `count:1`, allowlisted labels and optional `durationMs`. Sum counts for counters; aggregate duration observations into histograms/percentiles. There is no persistent in-process metric registry, sampling, queue or public metrics endpoint. No payloads, URLs, tokens, exception messages, audio, transcript text, customer identities or arbitrary tool/intent/model names enter these records. Unknown keys AND unknown categorical values are discarded. Numeric status codes are bounded. Only generated UUID-shaped correlation IDs are accepted. Logger redaction also covers common sensitive fields; static log messages remain the responsibility of existing callers.

## Coverage and measurement definitions

| Path | Observations | Limits |
| --- | --- | --- |
| Next API handlers using `withErrorHandling` | `http.request`: count, grouped route, HTTP status, outcome, handler latency; response ID; contextual logger ID | Response construction time, not streamed-body completion; framework redirects escaping the wrapper are reported as errors |
| Gateway HTTP server | `http.request`: count, status, outcome, response finish/early-close duration, response ID | No route labels or WebSocket upgrade counts |
| In-process voice session | `voice.stt`: final transcript latency without text; `voice.tts`: completed playback latency; `voice.failure` for provider errors; `voice.state`; session start/end with allowlisted end reason | STT elapsed time follows existing endpoint-to-final measurement; TTS includes playback; these are not vendor-only inference timings |
| In-process audio | `voice.audio`: inbound/outbound media duration at end; `voice.processing`: accumulated synchronous receiveAudio wall time | Processing includes codec conversion, write and VAD work; not asynchronous inference, CPU time or Python processing |
| Web STT/TTS gateway | completion/error elapsed time, provider, abort/timeout outcome | STT includes realtime audio pacing; TTS includes collection; validation failures are covered by HTTP status |
| STT/TTS fallback adapters | `voice.fallback` when a secondary compatible provider is selected | Not emitted on every circuit skip; standalone adapter callbacks may have independent IDs |
| Pipecat remote session | gateway-side final STT/TTS events, provider errors, state changes, session start/end and reason | Python internals, worker exporter, provider labels and inference/audio-processing metrics remain uninstrumented |
| Agent runtime | `runtime.outcome`: completed/failed/cancelled turn latency; rejected tool intent count | Rejected tools share this metric; no arbitrary user intent labels |
| Controlled tools | `tool.outcome`: success/failure elapsed time, sanitized exception classification | No tool name, arguments or result payload |
| BookingService book/reschedule/cancel | `booking.outcome`: success/rejection/exception and elapsed time | Database result is authoritative; success does not prove calendar sync; operations are aggregated |
| Shared `withRetry` | `dependency.attempt`: every attempt latency/outcome; `dependency.retry`: retry count; Google Calendar explicitly labeled | Other users grouped as `other`; TimeoutError and AbortError classified, raw errors omitted; no new retry behavior |

Existing runtime and call persistence events are preserved. Telemetry sink exceptions are contained, including logger serialization/sink failures. Calls do not wait on an external exporter. Stdout can still exert process backpressure under a slow local consumer; this foundation emits lifecycle observations, not one log per audio frame. Failed output is dropped without retry or a recursive error log.

Not covered: direct dependency fetches outside the retry helper (including most LLM HTTP calls, OAuth, database and messaging paths that bypass it), background jobs without an instrumented boundary, API handlers bypassing `withErrorHandling`, end-to-end trace propagation, browser instrumentation, Python process health/metrics, durable aggregation and alert delivery. Existing provider/runtime logs are not a complete tracing system. Intent visibility is limited to tool proposal rejections and tool/booking results; arbitrary semantic intent values are deliberately not exported.

## Health and readiness

`GET /api/health` remains cheap liveness only. Authenticated, rate-limited `?deep=1` retains existing readiness checks and now reports telemetry configuration. Exporter configuration is not exporter health; stdout delivery cannot be confirmed. Gateway `/health` retains its existing process/session visibility. Neither liveness nor local configuration proves an external provider is functioning. A deep provider probe describes only that probe at that instant.

## Local queries and dashboard sketches

Extract telemetry only (Next startup text and existing logs are ignored):

```sh
jq -R 'fromjson? | select(.telemetry) | .telemetry' /tmp/halo-app.log
# Counts grouped by event and outcome; IDs are never aggregation keys:
jq -Rs '[split("\n")[] | fromjson? | .telemetry // empty] | group_by([.event,.labels.outcome]) | map({event:.[0].event,outcome:.[0].labels.outcome,count:map(.count)|add})' /tmp/halo-app.log
# Individual request latency observations:
jq -R 'fromjson? | .telemetry | select(.event == "http.request") | {labels,durationMs}' /tmp/halo-app.log
```

Speech duration labels include `engine` and `phase` so endpoint, playback, upload and synthesis measurements stay separate.

Useful later panels: request rate and 5xx percentage by component/route; request and voice latency p50/p95; session-end reasons; fallback frequency by operation/provider; booking rejection/error percentage; dependency attempt failures and retries. Keep transport success, business rejection and cancellation separate. Avoid comparing STT endpoint latency with whole-upload latency as if they were the same measurement.

## Future staging backend

After backend selection, cost review and approval, adapt this single boundary to the chosen stack (prefer an OpenTelemetry SDK/collector if required by staging). Preserve the existing allowlists. Use bounded asynchronous batches, explicit queue/drop limits, short timeouts, shutdown flushing within the platform grace period and fail-open behavior. Do not instrument global fetch or export payloads/SQL blindly. Test exporter disconnection, slow consumers, cancellation and redaction with synthetic traffic before enabling staging. Keep IDs out of metric attributes. Do not enable production export or connect any account as part of this change.
