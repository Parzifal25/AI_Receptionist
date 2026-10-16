# W4.3 — overlap synthesis with confirmed playout

Owner authority: P2-LOOP task and completion-loop instruction, 2026-10-15.
Status: LOCALLY COMPLETE; manual post-fix review and synthetic measurement recorded.
Hosted/provider measurements remain pending. Evidence level: source/local test only.

Problem: `MediaGate._play_chunks` waits for the carrier mark before requesting
its next TTS chunk. The in-process session already streams the next synthesis
while transport buffers the current audio. The worker has an avoidable per-chunk
synthesis gap; no real provider baseline or D9 latency target is approved.

Baseline: reproduce the serial worker in a synthetic benchmark with 30 ms
synthesis and 100 ms playout per chunk, two chunks, ten samples. Record actual
monotonic times and p50/p95 of total duration and the sentence-boundary gap.
Run before any W4.3 change, then on the pipelined worker under identical conditions.
The injected delays are test conditions, not provider measurements.

Milestones: gateway audio arrival, VAD start/end, STT final, runtime context and
validated reply, TTS start/first audio, chunk synthesis, queued carrier mark,
confirmed carrier mark, next sentence first audio, completed/failed playback.
Use existing schema-1 privacy-safe timing marks and synthetic playback IDs;
never transcript/audio contents. `voice:latency` covers the separate Node path.

Scope: `services/pipecat-worker/media_gate.py`, `worker.py`, dedicated worker
regression tests, synthetic benchmark script and evidence. Trace upstream through
`src/app/api/widget/voice`, gateway server, Pipecat bridge, remote session and
turn handler; downstream through TTS, sink FIFO, audio writer and carrier marks.
No prompt, model, STT, μ-law, business policy, API auth or schema changes.

Design constraint: enqueue the current chunk's mark synchronously BEFORE arming
the next synthesis. Prefetch at most one chunk. Audio remains FIFO and belongs
to the single playback. Never acknowledge synthesis as delivery. Cancel pending
mark waits and buffered audio on interruption/close. Legacy test waiters remain
serial; production uses an explicit synchronous mark-starter callback.

Acceptance: executable single-playback, prefix-only delivery, late-audio/mark,
interruption, timeout, cleanup and failed-ack tests; next synthesis starts before
previous mark acknowledgement; synthetic gap improves with documented sample
size and conditions. Required regression suites also cover takeover/replay,
Telugu/Tenglish/English text and language selection, knowledge/act-then-narrate,
serialized turns, handoff ownership, committed-turn cancellation and correlation.
These are existing source contracts, not a new claim of language quality.

Commands: worker unittest discovery; dedicated benchmark; `npm run voice:latency
-- --calls 2 --turns 2`; canonical typecheck/lint/architecture/neutral/full tests,
preflight and build. Artifacts in `docs/evidence/phase2-completion-*` and ledger.
Rollback: reverse only this task's diff, restoring serial waiter wiring. No DB
rollback. Risks: marker reordering, stale contexts, excess buffering, false
completion, cancellation leaks. Hosted validation: actual vendor FIFO/context
behavior, PSTN pacing, Telugu quality, real percentile latency and provider usage
remain blocked on D8/D17/D9 and exact target authorization. Local fakes cannot
close them. No new architecture or provider selection is proposed.
