"""The HALO media gate — Pipecat frames ⇄ HALO's control protocol.

STATUS: IMPLEMENTED, offline-tested (protocol semantics unit tests and an
end-to-end run over real WebSockets with fake STT/TTS/VAD services). It has
never run against real Sarvam credentials, so no Telugu quality or latency
claim is made anywhere.

This is the missing half of the Phase 4 integration: `halo_client.py` speaks
the control protocol but knows nothing of media; `halo_serializer.py` moves
audio but knows nothing of the control plane; `media_gate.py` binds the two.
It is a Pipecat `FrameProcessor` placed in the pipeline (between the TTS
service and the transport output, so it sees exactly the audio that will be
sent to the caller) AND the `HaloControlClient.Handlers` implementation:

    media WS ─▶ [Input] ─▶ VAD ─▶ STT ─▶ ... ─▶ TTS ─▶ GATE ─▶ [Output] ─▶ media WS
                                                ▲│
                 WSS /pipecat/control ──────────┘└─ HaloControlClient ⇄ HALO

The three rules a worker must not break (services/pipecat-worker/README.md):

  1. It never chooses a tenant or an agent. Identity arrives in `ready` and
     is used for correlation in logs only.
  2. It never speaks a line HALO did not send. Every synthesis starts from a
     `speak` command; the gate queues nothing else and invents nothing.
  3. The production worker binds a playout waiter: `chunk_played` is emitted
     only after the carrier acknowledges a mark queued after the chunk audio.
     Interrupted and stale marks do not acknowledge unplayed speech.

Each HALO chunk is queued as TTSSpeakFrame. Pipecat owns synthesis and
context completion; HALO owns the already-validated text. A TTSTextFrame is
an OUTPUT frame and bypasses the normal speech-request completion path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from uuid import uuid4
from policy_audio_cache import PolicyAudioCache
from typing import Any, Callable, Optional

from halo_client import HaloControlClient, SessionIdentity, SpeakRequest, VoiceConfig
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
    InterimTranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSUpdateSettingsFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import TTSSettings

log = logging.getLogger("halo.gate")

# How long a chunk may take between being queued and its first TTS audio.
# Covers synthesis start; a chunk that produces no context (empty text) fails
# here instead of hanging the playback. Long enough for cold vendor sockets.
CHUNK_START_TIMEOUT_S = 15.0

# How long a chunk that HAS started may keep producing audio after its last
# frame, as a safety net against a vendor socket dying mid-context.
CHUNK_DRAIN_TIMEOUT_S = 30.0

# How often cumulative media usage is reported.
USAGE_INTERVAL_S = 10.0


def _stdout_timing(record: dict) -> None:
    """One JSON line per mark, the worker's half of HALO_TELEMETRY=stdout."""
    sys.stdout.write(json.dumps({"timing": record}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class MediaGate(FrameProcessor):
    """Pipeline processor and control-plane handler in one object.

    `bind_task()` must be called with the PipelineTask before the first
    `speak`, so the gate can queue TTSSpeakFrames into the running pipeline.
    """

    def __init__(self, client: HaloControlClient, **kwargs) -> None:
        super().__init__(**kwargs)
        self._client = client
        self._task: Any = None
        self._task_ready = asyncio.Event()
        self._policy_audio = PolicyAudioCache()
        self._cache_scope = None
        self._closed = False
        self._completion_callback = None
        self._playout_waiter = None
        self._playout_starter = None
        # Called when a playback is cut (barge-in / stop_playback): the media
        # writer uses this to drop already-buffered audio out-of-band, the
        # same contract pipecat's websocket output transport implements.
        self._interrupt_listeners: list = []

        # --- speak queue: at most one active playback, in arrival order ----
        self._speak_queue: asyncio.Queue[Optional[SpeakRequest]] = asyncio.Queue()
        self._speak_loop_task: Optional[asyncio.Task] = None
        self._active: Optional[_Playback] = None
        self._interrupted_ids: set[str] = set()
        # The language the TTS service is configured for right now, and the
        # one the session started with. HALO names a language per line; the
        # worker never chooses one and never detects one.
        self._default_language: Optional[str] = None
        self._tts_language: Optional[str] = None

        # --- STT session state ---------------------------------------------
        self._utterance_seq = 0
        # The vendor may emit the final before or after VAD's speech_stopped.
        # Finals are HELD until the utterance ends, then committed in order —
        # the session contract: "HALO holds finals until the utterance
        # endpoints, then commits exactly one turn." An interruption drops
        # them: half-heard text must not be answered.
        self._pending_finals: list[_Final] = []
        self._speaking = False
        # Barge-in waits for sustained speech (bargeIn.minSpeechMs), measured
        # in caller audio from the moment speech began — the same rule as
        # HALO's in-process session — so a cough or a backchannel does not
        # cut the agent off. VAD has already heard vad.minSpeechMs of speech
        # when it reports a start. A transcript during the utterance also
        # proves speech and barges in at once.
        self._vad_min_speech_ms = 0
        self._barge_in_min_speech_ms = 0
        self._barge_pending = False
        self._speech_audio_ms = 0.0

        # --- usage accounting (cumulative) ----------------------------------
        self._inbound_audio_ms = 0.0
        self._outbound_audio_ms = 0.0
        self._tts_characters = 0
        self._usage_task: Optional[asyncio.Task] = None
        self._max_duration_task: Optional[asyncio.Task] = None

        # --- latency marks (observation only) --------------------------------
        # Opt-in with the same switch as HALO's telemetry. Marks carry a
        # monotonic clock, ids HALO generated and counts — never text, audio
        # or numbers the caller said. They change nothing about the call.
        self._timing_sink: Optional[Callable[[dict], None]] = (
            _stdout_timing if os.environ.get("HALO_TELEMETRY") == "stdout" else None
        )
        self._session_id = ""

    # ------------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------------

    def bind_task(self, task: Any) -> None:
        """Give the gate a PipelineTask so it can queue frames into the pipeline."""
        self._task = task
        self._task_ready.set()

    def set_playout_waiter(self, callback) -> None:
        """Wait for the transport/carrier to acknowledge a fully sent chunk."""
        self._playout_waiter = callback

    def set_playout_starter(self, callback) -> None:
        """Synchronously enqueue a carrier mark; return its confirmation awaitable.

        Unlike the legacy async waiter, this guarantees the marker precedes
        the next chunk's audio in the transport FIFO, enabling one-chunk overlap.
        """
        self._playout_starter = callback

    def set_completion_callback(self, callback) -> None:
        """Called with no arguments when the session ends (hangup or failure)."""
        self._completion_callback = callback

    def set_timing_sink(self, sink: Optional[Callable[[dict], None]]) -> None:
        """Replace where latency marks go (None turns them off)."""
        self._timing_sink = sink

    def mark(self, name: str, **fields: Any) -> None:
        sink = self._timing_sink
        if sink is None:
            return
        try:
            sink({"schema": 1, "mark": name, "monoMs": round(time.monotonic() * 1000.0, 3),
                  "session": self._session_id, **fields})
        except Exception:  # noqa: BLE001 - a mark must never affect the call
            pass

    def add_interrupt_listener(self, listener) -> None:
        """Register a zero-argument callback fired the instant a playback is cut."""
        self._interrupt_listeners.append(listener)

    async def close(self, reason: str = "transport_closed") -> None:
        """The media leg (or the process) is going away. Report and stop."""
        if self._closed:
            return
        self._closed = True
        self._policy_audio.clear()
        active = self._active
        if active is not None and not active.settled:
            # The caller heard nothing more after this point. Not "interrupted":
            # nothing cut it — the session is gone.
            await self._client.playback_stopped(
                active.request.playback_id, "failed", audio_ms=active.played_ms
            )
            active.settled = True
        if active is not None and active.playout_task is not None:
            active.playout_task.cancel()
        self._cancel_speak_loop()
        await self._stop_background_tasks()
        await self._client.bye(reason)
        if self._completion_callback is not None:
            try:
                await self._completion_callback()
            except Exception:  # noqa: BLE001 - reporting must not fail the close
                log.exception("completion callback failed")

    # ------------------------------------------------------------------
    # HaloControlClient.Handlers — the control-plane half
    # ------------------------------------------------------------------

    async def on_ready(self, identity: SessionIdentity, voice: VoiceConfig) -> None:
        if self._closed:
            return
        log.info(
            "media gate ready call=%s session=%s correlation=%s language=%s",
            identity.call_id,
            identity.session_id,
            identity.correlation_id,
            voice.language,
        )
        # Identity is logged, never acted on: the tenant was resolved by HALO
        # from the dialled number, and the worker has no use for it beyond
        # correlation. Media knobs are the worker's to apply.
        self._policy_audio.clear()
        self._cache_scope = (identity.tenant_id, identity.agent_version_id, voice.profile_id, voice.voice_id, voice.speaking_rate)
        self._default_language = voice.language
        self._tts_language = voice.language
        self._vad_min_speech_ms = max(0, voice.vad_min_speech_ms)
        self._barge_in_min_speech_ms = max(0, voice.barge_in_min_speech_ms)
        self._session_id = identity.session_id
        self.mark("ready")
        self._usage_task = asyncio.create_task(self._usage_loop())
        self._max_duration_task = asyncio.create_task(
            self._max_duration_watchdog(max(voice.max_call_duration_ms / 1000.0, 1.0))
        )

    async def on_speak(self, request: SpeakRequest) -> None:
        if self._closed:
            return
        self.mark("speak_received", playbackId=request.playback_id, chunks=len(request.chunks),
                  chars=sum(len(chunk) for chunk in request.chunks))
        await self._speak_queue.put(request)
        if self._speak_loop_task is None or self._speak_loop_task.done():
            self._speak_loop_task = asyncio.create_task(self._speak_loop())

    async def on_stop_playback(self, playback_id: str, reason: str) -> None:
        if self._closed:
            return
        active = self._active
        if active is not None and active.request.playback_id == playback_id:
            await self._interrupt_playback(active)

    async def on_hangup(self, reason: str) -> None:
        if self._closed:
            return
        log.info("halo hangup: %s", reason)
        await self.close("transport_closed")

    # ------------------------------------------------------------------
    # Pipeline half
    # ------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._speaking = True
            self.mark("vad_start")
            await self._client.speech_started()
            self._barge_pending = True
            self._speech_audio_ms = float(self._vad_min_speech_ms)
            await self._barge_in_if_sustained()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._speaking = False
            self._barge_pending = False
            self.mark("vad_stop")
            await self._client.speech_stopped()
            await self._commit_utterance()
        elif isinstance(frame, TranscriptionFrame):
            if frame.text.strip():
                await self._barge_in_on_transcript()
            await self._on_final_transcript(frame)
        elif isinstance(frame, InterimTranscriptionFrame):
            text = frame.text.strip()
            if text:
                await self._barge_in_on_transcript()
                await self._client.transcript(
                    text[:2000], final=False, language=_lang_str(frame.language)
                )
        elif isinstance(frame, TTSStartedFrame):
            self._on_tts_started(frame)
        elif isinstance(frame, TTSAudioRawFrame):
            active = self._active
            if active is None or active.settled or active.request.playback_id in self._interrupted_ids or active.context_id != frame.context_id:
                return  # Late synthesis must never reach the carrier.
            await self._on_tts_audio(frame)
        elif isinstance(frame, TTSStoppedFrame):
            await self._on_tts_stopped(frame)
        elif isinstance(frame, InputDTMFFrame):
            await self._client.dtmf(_digit(frame.button))
        elif isinstance(frame, InputAudioRawFrame):
            frame_ms = _audio_ms(frame.audio, frame.sample_rate)
            self._inbound_audio_ms += frame_ms
            if self._speaking and self._barge_pending:
                if frame.metadata.get("halo_vad_speech") is False:
                    self._speech_audio_ms = 0.0
                elif not frame.metadata.get("halo_vad_start"):
                    # Start already includes the VAD minimum; do not count the
                    # onset frame twice. Untagged unit fixtures retain the
                    # legacy speech-interval contract.
                    self._speech_audio_ms += frame_ms
                await self._barge_in_if_sustained()
        elif isinstance(frame, ErrorFrame):
            # pipecat ErrorFrame is not inherently fatal; a fatal one is.
            fatal = bool(getattr(frame, "fatal", False))
            await self._client.error("pipeline", "pipeline_error", retryable=not fatal)
            if fatal:
                await self.close("pipeline_failure")

        # The gate sits mid-pipeline (after TTS, before the transport output).
        # Every frame MUST be re-pushed or the pipeline stalls.
        await self.push_frame(frame, direction)

    # ------------------------------------------------------------------
    # Speak loop
    # ------------------------------------------------------------------

    async def _speak_loop(self) -> None:
        """Drain the speak queue: one playback at a time, in arrival order."""
        while not self._closed:
            try:
                request = await asyncio.wait_for(self._speak_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if request is None or self._closed:
                break
            playback = _Playback(request)
            self._active = playback
            try:
                # Own the queued playback while speech services start, so a
                # stop/hangup during startup cancels it before any synthesis.
                if self._task is None:
                    await asyncio.wait_for(self._task_ready.wait(), CHUNK_START_TIMEOUT_S)
                if self._closed or request.playback_id in self._interrupted_ids:
                    continue
                await self._play_chunks(playback)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — never log vendor text or a raw traceback
                log.error("playback failed reason=media_pipeline_failure")
                await self._client.playback_stopped(
                    request.playback_id, "failed", audio_ms=playback.played_ms
                )
                playback.settled = True
                await self._interrupt_playback(playback, report=False)
            finally:
                if playback.playout_task is not None:
                    playback.playout_task.cancel()
                self._interrupted_ids.discard(request.playback_id)
                if self._active is playback:
                    self._active = None

    def _cancel_speak_loop(self) -> None:
        task, self._speak_loop_task = self._speak_loop_task, None
        if task is not None and not task.done():
            task.cancel()

    async def _play_chunks(self, playback: _Playback) -> None:
        request = playback.request
        await self._apply_language(request.language or self._default_language)
        for index, chunk in enumerate(request.chunks):
            if self._closed or request.playback_id in self._interrupted_ids:
                break
            if self._task is None:
                log.error("media gate has no bound PipelineTask; cannot speak")
                await self._client.error("tts", "gate_unbound", retryable=False)
                await self._client.playback_stopped(
                    request.playback_id, "failed", audio_ms=playback.played_ms
                )
                playback.settled = True
                return

            # One chunk ahead at most; a prefetched chunk is already armed.
            if playback.chunk_index != index:
                await self._queue_chunk(playback, index)

            synthesis_completed = False
            try:
                await asyncio.wait_for(playback.chunk_event.wait(), timeout=CHUNK_START_TIMEOUT_S)
                synthesis_completed = True
            except asyncio.TimeoutError:
                pass
            if (not synthesis_completed or playback.awaiting_context or playback.chunk_audio_ms <= 0) and not self._closed and request.playback_id not in self._interrupted_ids:
                log.warning(
                    "chunk %d of playback %s produced no audio within %.0fs",
                    index,
                    request.playback_id,
                    CHUNK_START_TIMEOUT_S,
                )
                await self._client.error("tts", "tts_timeout", retryable=True)
                await self._client.playback_stopped(
                    request.playback_id, "failed", audio_ms=playback.played_ms
                )
                playback.settled = True
                await self._interrupt_playback(playback, report=False)
                return

            if self._closed or request.playback_id in self._interrupted_ids:
                break

            self.mark("chunk_synthesized", playbackId=request.playback_id, chunk=index,
                      audioMs=round(playback.chunk_audio_ms, 1))
            if self._playout_starter is not None or self._playout_waiter is not None:
                if self._playout_starter is not None:
                    # The starter enqueues the current marker synchronously.
                    # Only then may the next synthesis put audio in the FIFO.
                    playback.playout_task = asyncio.ensure_future(self._playout_starter(request.playback_id, index))
                    if index + 1 < len(request.chunks):
                        await self._queue_chunk(playback, index + 1)
                else:
                    playback.playout_task = asyncio.ensure_future(self._playout_waiter(request.playback_id, index))
                try:
                    confirmed = await playback.playout_task
                except asyncio.CancelledError:
                    if self._closed or request.playback_id in self._interrupted_ids:
                        return
                    raise
                finally:
                    playback.playout_task = None
                if self._closed or request.playback_id in self._interrupted_ids:
                    break
                if not confirmed:
                    await self._client.playback_stopped(request.playback_id, "failed", audio_ms=playback.played_ms)
                    playback.settled = True
                    await self._interrupt_playback(playback, report=False)
                    return
                self.mark("chunk_playout_confirmed", playbackId=request.playback_id, chunk=index)
            # Production transport waits for a carrier mark after all audio.
            # Synthesis completion alone is not evidence of delivery.
            await self._client.playback_chunk_played(request.playback_id, index)
            playback.acked = index + 1

        if (
            not playback.settled
            and not self._closed
            and request.playback_id not in self._interrupted_ids
        ):
            await self._client.playback_stopped(
                request.playback_id, "completed", audio_ms=playback.played_ms
            )
            playback.settled = True
            self.mark("playback_completed", playbackId=request.playback_id, audioMs=round(playback.played_ms, 1))
        self._interrupted_ids.discard(request.playback_id)

    async def _queue_chunk(self, playback: _Playback, index: int) -> None:
        playback.chunk_index = index
        playback.awaiting_context = True
        playback.context_id = None
        playback.chunk_audio_ms = 0.0
        playback.chunk_event = asyncio.Event()
        chunk = playback.request.chunks[index]
        self.mark("chunk_queued", playbackId=playback.request.playback_id, chunk=index, chars=len(chunk))
        request = playback.request
        playback.cache_key = None
        playback.cache_frames = []
        if self._cache_scope is not None and request.kind == "policy" and request.turn_id is None:
            playback.cache_key = (*self._cache_scope, request.language or self._default_language, chunk)
            cached = self._policy_audio.get(playback.cache_key)
            if cached is not None:
                self.mark("policy_cache_hit", playbackId=request.playback_id, chunk=index)
                context = "cache-" + uuid4().hex
                self._on_tts_started(TTSStartedFrame(context_id=context))
                for audio, rate, channels, encoding in cached:
                    if self._closed or request.playback_id in self._interrupted_ids:
                        return
                    frame = TTSAudioRawFrame(audio=audio, sample_rate=rate, num_channels=channels, context_id=context)
                    frame.metadata["halo_audio_encoding"] = encoding
                    if encoding == "mulaw":
                        frame.num_frames = len(audio) // channels
                    await self.process_frame(frame, FrameDirection.DOWNSTREAM)
                playback.context_id = None
                playback.chunk_event.set()
                return
        self._tts_characters += len(chunk)
        await self._task.queue_frame(TTSSpeakFrame(text=chunk, append_to_context=False))

    async def _apply_language(self, language: Optional[str]) -> None:
        """Point the TTS service at the language HALO named for this line.

        A control frame queued ahead of the line's TTSSpeakFrames, so it is
        applied in order. Sent only on a change: the vendor re-reads its
        whole configuration each time.
        """
        if not language or language == self._tts_language or self._task is None:
            return
        self._tts_language = language
        await self._task.queue_frame(TTSUpdateSettingsFrame(delta=TTSSettings(language=language)))

    def forget_tts_language(self) -> None:
        """The TTS service was replaced by its fallback, which has seen none
        of the language switches: name the language again on the next line."""
        self._tts_language = None
        self._policy_audio.clear()  # a fallback or new service has different audio
        if self._active is not None:
            self._active.cache_key = None
            self._active.cache_frames = None

    async def _barge_in_if_sustained(self) -> None:
        if self._barge_pending and self._speech_audio_ms >= self._barge_in_min_speech_ms:
            self._barge_pending = False
            await self._client.speech_progress(self._speech_audio_ms)
            await self._maybe_barge_in()

    async def _barge_in_on_transcript(self) -> None:
        # Before the text is held: the cut drops finals from before it, and
        # this transcript is the speech that interrupted, so it must survive.
        active = self._active
        if self._speaking and self._barge_pending and active is not None and active.request.interruptible:
            self._barge_pending = False
            await self._maybe_barge_in()

    async def _maybe_barge_in(self) -> None:
        active = self._active
        if active is None or active.settled:
            return
        # A handoff or hang-up line must be heard in full: HALO marks it
        # non-interruptible and the gate honours that here.
        if not active.request.interruptible:
            return
        await self._interrupt_playback(active)

    async def _interrupt_playback(self, playback: _Playback, *, report: bool = True) -> None:
        """Cut the active playback locally FIRST, report SECOND.

        `reason` on the wire admits completed|interrupted|failed. Anything
        that stops a playback before its end is `interrupted` from the
        caller's perspective.
        """
        self._interrupted_ids.add(playback.request.playback_id)
        if playback.playout_task is not None:
            playback.playout_task.cancel()
        self.mark("interrupt_start", playbackId=playback.request.playback_id, chunk=playback.chunk_index)
        # Out-of-band first: the media writer drops audio it has already
        # buffered, so nothing queued before the cut reaches the caller.
        for listener in self._interrupt_listeners:
            try:
                listener()
            except Exception:  # noqa: BLE001 - a listener must not block the cut
                log.exception("interrupt listener failed")
        if not playback.settled and report:
            await self._client.playback_stopped(
                playback.request.playback_id, "interrupted", audio_ms=playback.played_ms
            )
            playback.settled = True
        # Half-heard text must not be answered: drop whatever the caller was
        # mid-way through saying and let the next utterance start clean.
        self._pending_finals = []
        self._utterance_seq += 1
        # Wake the chunk wait so the speak loop moves on immediately.
        if playback.chunk_event is not None:
            playback.chunk_event.set()
        # Cut synthesis and drop the audio already queued in the transport.
        # The transport's handle_interruptions also clears its own buffer.
        if self._task is not None:
            await self._task.queue_frame(InterruptionFrame())
        self.mark("interrupt_done", playbackId=playback.request.playback_id, heardMs=round(playback.played_ms, 1))

    # ------------------------------------------------------------------
    # TTS attribution
    # ------------------------------------------------------------------

    def _on_tts_started(self, frame: TTSStartedFrame) -> None:
        """Bind a fresh TTS context to the chunk the speak loop just armed.

        The service serialises contexts strictly FIFO and the loop arms
        (awaiting_context) exactly one chunk at a time, so an unseen
        start-frame while a chunk is armed IS that chunk's context. Start
        frames that arrive while nothing is armed (an interruption abandoned
        a context) are ignored.
        """
        playback = self._active
        if playback is None or not playback.awaiting_context:
            return
        playback.context_id = frame.context_id
        playback.awaiting_context = False
        self.mark("chunk_tts_started", playbackId=playback.request.playback_id, chunk=playback.chunk_index)

    async def _on_tts_audio(self, frame: TTSAudioRawFrame) -> None:
        playback = self._active
        if playback is None or playback.context_id != frame.context_id:
            return
        encoding = frame.metadata.get("halo_audio_encoding", "pcm16")
        ms = _audio_ms(frame.audio, frame.sample_rate, encoding)
        if playback.cache_key is not None and playback.cache_frames is not None:
            playback.cache_frames.append((bytes(frame.audio), frame.sample_rate, frame.num_channels, encoding))
            if len(playback.cache_frames) > 256 or sum(len(f[0]) for f in playback.cache_frames) > 128000:
                playback.cache_frames = None
        playback.played_ms += ms
        if playback.chunk_audio_ms == 0.0:
            self.mark("chunk_first_audio", playbackId=playback.request.playback_id, chunk=playback.chunk_index)
        playback.chunk_audio_ms += ms
        self._outbound_audio_ms += ms
        if not playback.first_audio:
            playback.first_audio = True
            await self._client.playback_first_audio(playback.request.playback_id)

    async def _on_tts_stopped(self, frame: TTSStoppedFrame) -> None:
        playback = self._active
        if playback is None or playback.awaiting_context or playback.settled or self._closed:
            return
        if playback.context_id != frame.context_id:
            return
        # Cache synthesis only, never a claim that it was delivered. A replay
        # still goes through this playback's own mark and interruption path.
        if playback.cache_key is not None and playback.cache_frames:
            self._policy_audio.put(playback.cache_key, playback.cache_frames)
        # The context drained: its audio is on its way to the transport.
        if playback.chunk_event is not None:
            playback.chunk_event.set()
        playback.context_id = None
        # Streaming TTS services pause their frame queue after a speak frame
        # until the output transport reports BotStoppedSpeaking. This pipeline
        # has no pipecat output transport, and the gate already plays one
        # chunk at a time, so it releases the service itself. Without this the
        # caller's next transcript and HALO's next line both queue behind the
        # pause and never move.
        await self.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)

    # ------------------------------------------------------------------
    # Transcripts
    # ------------------------------------------------------------------

    async def _on_final_transcript(self, frame: TranscriptionFrame) -> None:
        text = frame.text.strip()
        if not text:
            return
        self._utterance_seq += 1
        final = _Final(
            utterance_id=f"u-{self._utterance_seq}",
            text=text[:2000],
            language=_lang_str(frame.language),
        )
        self._pending_finals.append(final)
        self.mark("stt_final", chars=len(final.text))
        if not self._speaking:
            # The final arrived after VAD already endpointed (vendor finals
            # can lag the VAD event): this final IS the utterance end.
            await self._commit_utterance()

    async def _commit_utterance(self) -> None:
        finals, self._pending_finals = self._pending_finals, []
        if finals:
            self.mark("transcript_committed", finals=len(finals))
        for final in finals:
            # confidence stays None: the Sarvam realtime endpoint emits no
            # per-utterance transcript confidence, and a fabricated number
            # silently disables HALO's read-back of misheard names.
            await self._client.transcript(
                final.text,
                final=True,
                utterance_id=final.utterance_id,
                language=final.language,
                confidence=None,
            )

    # ------------------------------------------------------------------
    # Background
    # ------------------------------------------------------------------

    async def _usage_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(USAGE_INTERVAL_S)
                if self._closed:
                    return
                await self._client.usage(
                    self._inbound_audio_ms, self._outbound_audio_ms, self._tts_characters
                )
        except asyncio.CancelledError:
            pass

    async def _max_duration_watchdog(self, max_seconds: float) -> None:
        try:
            await asyncio.sleep(max_seconds)
            if not self._closed:
                log.warning("max call duration reached; ending the media leg")
                # Not the worker's authority to hang up on the caller — it
                # reports and lets HALO end the call through the provider.
                await self.close("worker_shutdown")
        except asyncio.CancelledError:
            pass

    async def _stop_background_tasks(self) -> None:
        for task in (self._usage_task, self._max_duration_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._usage_task = None
        self._max_duration_task = None


class _Final:
    __slots__ = ("utterance_id", "text", "language")

    def __init__(self, utterance_id: str, text: str, language: Optional[str]) -> None:
        self.utterance_id = utterance_id
        self.text = text
        self.language = language


class _Playback:
    """One `speak` command moving through the pipeline.

    Context lifecycle per chunk: the loop arms awaiting_context=True → a
    TTSStartedFrame binds context_id → TTSAudioRawFrames accumulate played_ms
    → the context's TTSStoppedFrame sets chunk_event → the loop acks the
    chunk and moves on.
    """

    def __init__(self, request: SpeakRequest) -> None:
        self.request = request
        self.acked = 0
        self.played_ms = 0.0
        self.chunk_audio_ms = 0.0
        self.first_audio = False
        self.settled = False
        self.chunk_index: Optional[int] = None
        self.context_id: Optional[str] = None
        self.awaiting_context = False
        self.chunk_event: Optional[asyncio.Event] = None
        self.playout_task: Optional[asyncio.Future] = None
        self.cache_key = None
        self.cache_frames = []


def _digit(button) -> str:
    value = getattr(button, "value", button)
    return str(value)[:4]


def _lang_str(language) -> Optional[str]:
    if language is None:
        return None
    return str(getattr(language, "value", language))[:16]


def _audio_ms(audio: bytes, sample_rate: int, encoding: str = "pcm16") -> float:
    if not audio or not sample_rate:
        return 0.0
    if encoding not in ("pcm16", "mulaw"):
        raise ValueError("unsupported output audio encoding")
    return (len(audio) / (1 if encoding == "mulaw" else 2)) * 1000.0 / sample_rate
