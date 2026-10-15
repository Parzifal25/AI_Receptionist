# Application telemetry foundation

HALO uses its existing JSON logger and runtime/voice events. There is no application OpenTelemetry SDK, metrics server, collector, new dependency or external account in this change. Next.js, the long-lived Node voice gateway and the Python Pipecat worker have different lifecycles. Log-derived metrics fit the existing deployment without an additional SDK lifecycle or overlapping framework. The lockfile declares optional OpenTelemetry API peers for Next and Vitest, but no application SDK/exporter. The reference deployment is Vercel for Next, with a separately hosted long-lived voice gateway/worker; an in-memory metrics registry would not provide durable cross-instance aggregation. This now includes local cross-process/job correlation, without a tracing SDK or hosted exporter.

## Configuration and local verification

`HALO_TELEMETRY=stdout` enables newline-delimited JSON observations. Unset, `disabled`, and all unknown values disable them. This setting is independent of `LOG_LEVEL`; existing operational logs remain enabled. No URL is accepted and no telemetry network requests are made. Leave disabled in production during this rollout: hosting platforms may forward stdout themselves.

```sh
HALO_TELEMETRY=stdout npm run dev > /tmp/halo-app.log 2>&1
# In another terminal, with existing local gateway configuration:
HALO_TELEMETRY=stdout npm run voice-gateway > /tmp/halo-gateway.log 2>&1
curl -i http://localhost:3000/api/health
```

The response includes a generated `x-request-id`. Find its `correlationId` in the `telemetry` JSON record. IDs from request headers are deliberately ignored. Each Node HTTP request gets a fresh ID; nested runtime/tools/retries/bookings inherit it with AsyncLocalStorage. Voice sessions generate a separate ID, shared with their runtime turns. IDs are log fields, never metric labels. Signed internal bodies now carry operation correlation across Next→gateway; authenticated stream tokens and the ready frame carry it into Python. A gateway entry still has its own transport request ID; the safe `gateway correlation accepted` record links it to `upstreamCorrelationId`.

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
| LLM fallback router (W7.1, added 2026-10-15) | `llm.attempt`: one per candidate attempt with latency and outcome (`ok`/`error`/`timeout`/`cancelled`, including a stream the consumer abandons); `llm.fallback`; `llm.cooldown` (`wait` with its duration, or `skip`); `llm.exhausted`. Labels: `component=llm`, the provider family (`groq`, `openrouter`, `ollama`, `anthropic`, `gemini`) and the failure `category` | Never the model name, prompt, error text or token counts; an unknown provider name is dropped. Single-provider deployments (no router) are not covered |

Existing runtime and call persistence events are preserved. Telemetry sink exceptions are contained, including logger serialization/sink failures. Calls do not wait on an external exporter. Stdout can still exert process backpressure under a slow local consumer; this foundation emits lifecycle observations, not one log per audio frame. Failed output is dropped without retry or a recursive error log.

Not covered: direct dependency fetches outside the retry helper (single-provider LLM HTTP calls outside the router, OAuth, database and messaging paths that bypass it), unlisted job/third-party internals, API handlers bypassing the documented audit/correlation wrappers, browser instrumentation, Python process health/metrics, durable aggregation and alert delivery. Existing provider/runtime logs are not a complete tracing system. Intent visibility is limited to tool proposal rejections and tool/booking results; arbitrary semantic intent values are deliberately not exported.

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

## WS4 local audit and correlation contract (2026-10-15)

D7 and D18 are locally authorized by the owner's finalization task. No hosted backend or deployment is authorized. Operational logs and allowlisted observations remain disabled/opt-in stdout as above; **durable security records use Postgres `audit_logs`, never stdout**. Apply additive `0036` to an authorized target before deploying the matching code; no target is authorized by this document.

`audit_logs` contains only operation ID, actor/tenant IDs when resolved, closed action/method/route category, outcome, safe reason, canonical correlation and server timestamp. Initial authentication or system/visitor records can have null identity. Tenant resolution comes from verified membership, server repository mappings or the authenticated service envelope, never arbitrary body metadata. RLS exposes only the member's tenant; unscoped records require a service operator. Clients have no audit write grant; the service can append/select but cannot modify, delete or truncate. Database owners can administer it; business deletion cascades records. There is no hash chain or protection against the database owner. No arbitrary audit metadata is accepted.

`attempted` is admission before execution, not proof that authentication or the side effect succeeded. `denied` is an explicit 401/403 or action denial. `succeeded` means the instrumented handler/executor reported completion, not that every remote system committed. `failed` is a known rejected request; `unknown` is conservative for errors/partial writes. Mandatory pre-attempt failure blocks protected mutations/cron/control work. Terminal audit failure emits only stage/reason/operation/correlation and leaves the durable attempt; it preserves an already-completed result and must never cause replay. Read/denial records are best effort during outages. Sign-out is deliberately fail-open. PostgREST audit writes use a five-second abort deadline. A crash between effect and terminal record leaves an unknown outcome. No distributed transaction exists.

Retention has no silently invented duration: synthetic records live until disposable teardown and business deletion cascades them. Real-data audit retention, backup copies and operations access need D23/R8 review before pilot data. Tenant SELECT follows existing member-read tool-audit policy; no new audit UI/export endpoint is added.

The canonical logical operation ID is a lower-case UUID shape (`8-4-4-4-12` hex); no semantic UUID version is required for deterministic job IDs. `x-request-id` identifies each HTTP entry, `correlationId` identifies logical context, business journey IDs retain their old meaning, and event/run/step/call/operation IDs identify individual records. No second trace identifier is necessary. Correlation is diagnostic, never authorization or idempotency. New internal bodies are HMAC-authenticated before context adoption; missing IDs preserve backward compatibility with a fresh local context, malformed signed IDs reject the body, and public headers never override context. The optional stream-token correlation is itself signed; tampering or extra fields reject it. Existing call records win on reattachment; a caller cannot relabel another call.

Workflow event/timer correlation is serialized in separate UUID columns, restored independently of the cron request, and never put in the customer payload. Invalid event IDs are normalized before persistence. Legacy event/timer and reminder/no-show/campaign roots derive opaque UUIDs from namespace + trusted tenant + persisted job identity; these scheduled jobs are separate operations, not fabricated reconstructions of an earlier HTTP trace. AsyncLocalStorage scopes each request/job and restores the parent; Python ContextVars isolate control/media tasks and reset on exit. Worker-owned loggers include canonical session correlation after ready. Third-party Python loggers and provider systems are not comprehensively instrumented; unsupported downstreams stop the context at the adapter and are an explicit visibility limit.

Replay policy is conservative. Unkeyed Google/Outlook/WhatsApp creates are one attempt per invocation. An ordinary workflow exception after entering an executor is outcome-unknown and dead-lettered; only internal `RetrySafeWorkflowError` explicitly certifies a safe retry. A completed executor whose history write fails is quarantined. Reminder exceptions after send begins leave a failed claim for reconciliation; only pre-send errors requeue. Existing call/campaign/workflow atomic claims and tenant checks remain. Independent/manual invocations, provider key expiry/implementation, crashes and cross-system transactions prevent any exactly-once claim. Resend retains its keyed retries; its existing content-derived key (including a 100-character body prefix) can collide for distinct messages and is a separate limitation requiring a caller-supplied operation-key design.

Logger privacy is **key-based recursive redaction**, plus static safe messages at inspected exception/provider sites. Request/response/header/data/payload/customer/contact/input/output containers, tokens, credentials, OAuth secrets and nested errors are excluded. Envelope fields are protected. This is not a guarantee that an arbitrary secret hidden in a safe-named string or developer-authored static message can never appear. WhatsApp recipient interpolation and raw error-body logging were removed; calendar/Resend token/provider failures use safe categories/status. Audit has no free-text container at all. Never enable arbitrary request/SQL/third-party debug logging as a substitute.

Reproduce with synthetic fixtures using the exact command ledger and disposable harnesses in [WORKSTREAM_4_REPORT.md](WORKSTREAM_4_REPORT.md). Local wire contracts are not a real Next/carrier/provider deployment or hosted exporter proof.
