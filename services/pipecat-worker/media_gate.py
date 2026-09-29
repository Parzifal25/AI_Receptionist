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
  3. It reports what the caller actually heard. `chunk_played` is emitted as
     each chunk's audio leaves the TTS towards the transport — a strict
     over-report of what has left the earpiece, which HALO's playback
     watchdog exists to survive — and `playback_stopped` carries an honest
     reason.

Why TTSTextFrame and not TTSSpeakFrame: TTSSpeakFrame synthesises the whole
text in ONE TTS context, so one audio stream covers N HALO chunks with no way
to attribute a played span to the chunk whose acknowledgement it should carry.
TTSTextFrame produces one audio context per chunk — the context boundary IS
the chunk boundary — so playback attribution stays exact end to end.

How attribution actually works (pipecat 0.0.108): the TTSService generates
its own context id for every aggregated text it receives (it overwrites the
context_id of the incoming TTSTextFrame), emits an AggregatedTextFrame and a
TTSStartedFrame carrying that id, then the TTSAudioRawFrames of that context
and finally a TTSStoppedFrame. Contexts are serialised strictly FIFO by the
service, so ONE AT A TIME the gate binds "the next chunk of the active
playback" to the FIRST TTSStartedFrame it has not seen yet, counts that
context's audio, and settles the chunk when the context's TTSStoppedFrame
passes through. A chunk that synthesises to silence never produces a context
at all; the gate detects that via the chunk-start timeout and reports it as
failed instead of hanging the speak loop.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from halo_client import HaloControlClient, SessionIdentity, SpeakRequest, VoiceConfig
from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
    InterimTranscriptionFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

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


class MediaGate(FrameProcessor):
    """Pipeline processor and control-plane handler in one object.

    `bind_task()` must be called with the PipelineTask before the first
    `speak`, so the gate can queue TTSTextFrames into the running pipeline.
    """

    def __init__(self, client: HaloControlClient, **kwargs) -> None:
        super().__init__(**kwargs)
        self._client = client
        self._task: Any = None
        self._closed = False
        self._completion_callback = None
        # Called when a playback is cut (barge-in / stop_playback): the media
        # writer uses this to drop already-buffered audio out-of-band, the
        # same contract pipecat's websocket output transport implements.
        self._interrupt_listeners: list = []

        # --- speak queue: at most one active playback, in arrival order ----
        self._speak_queue: asyncio.Queue[Optional[SpeakRequest]] = asyncio.Queue()
        self._speak_loop_task: Optional[asyncio.Task] = None
        self._active: Optional[_Playback] = None
        self._interrupted_ids: set[str] = set()

        # --- STT session state ---------------------------------------------
        self._utterance_seq = 0
        # The vendor may emit the final before or after VAD's speech_stopped.
        # Finals are HELD until the utterance ends, then committed in order —
        # the session contract: "HALO holds finals until the utterance
        # endpoints, then commits exactly one turn." An interruption drops
        # them: half-heard text must not be answered.
        self._pending_finals: list[_Final] = []
        self._speaking = False

        # --- usage accounting (cumulative) ----------------------------------
        self._inbound_audio_ms = 0.0
        self._outbound_audio_ms = 0.0
        self._tts_characters = 0
        self._usage_task: Optional[asyncio.Task] = None
        self._max_duration_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------------

    def bind_task(self, task: Any) -> None:
        """Give the gate a PipelineTask so it can queue frames into the pipeline."""
        self._task = task

    def set_completion_callback(self, callback) -> None:
        """Called with no arguments when the session ends (hangup or failure)."""
        self._completion_callback = callback

    def add_interrupt_listener(self, listener) -> None:
        """Register a zero-argument callback fired the instant a playback is cut."""
        self._interrupt_listeners.append(listener)

    async def close(self, reason: str = "transport_closed") -> None:
        """The media leg (or the process) is going away. Report and stop."""
        if self._closed:
            return
        self._closed = True
        active = self._active
        if active is not None and not active.settled:
            # The caller heard nothing more after this point. Not "interrupted":
            # nothing cut it — the session is gone.
            await self._client.playback_stopped(
                active.request.playback_id, "failed", audio_ms=active.played_ms
            )
            active.settled = True
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
        self._usage_task = asyncio.create_task(self._usage_loop())
        self._max_duration_task = asyncio.create_task(
            self._max_duration_watchdog(max(voice.max_call_duration_ms / 1000.0, 1.0))
        )

    async def on_speak(self, request: SpeakRequest) -> None:
        if self._closed:
            return
        self._tts_characters += sum(len(chunk) for chunk in request.chunks)
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
            await self._client.speech_started()
            await self._maybe_barge_in()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._speaking = False
            await self._client.speech_stopped()
            await self._commit_utterance()
        elif isinstance(frame, TranscriptionFrame):
            await self._on_final_transcript(frame)
        elif isinstance(frame, InterimTranscriptionFrame):
            text = frame.text.strip()
            if text:
                await self._client.transcript(
                    text[:2000], final=False, language=_lang_str(frame.language)
                )
        elif isinstance(frame, TTSStartedFrame):
            self._on_tts_started(frame)
        elif isinstance(frame, TTSAudioRawFrame):
            await self._on_tts_audio(frame)
        elif isinstance(frame, TTSStoppedFrame):
            await self._on_tts_stopped(frame)
        elif isinstance(frame, InputDTMFFrame):
            await self._client.dtmf(_digit(frame.button))
        elif isinstance(frame, InputAudioRawFrame):
            self._inbound_audio_ms += _audio_ms(frame.audio, frame.sample_rate)
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
                await self._play_chunks(playback)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a vendor failure must not kill the pipeline
                log.exception("playback %s failed: %s", request.playback_id, exc)
                await self._client.playback_stopped(
                    request.playback_id, "failed", audio_ms=playback.played_ms
                )
                playback.settled = True
            finally:
                if self._active is playback:
                    self._active = None

    def _cancel_speak_loop(self) -> None:
        task, self._speak_loop_task = self._speak_loop_task, None
        if task is not None and not task.done():
            task.cancel()

    async def _play_chunks(self, playback: _Playback) -> None:
        request = playback.request
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

            # ONE TTSTextFrame per HALO chunk. The TTS service assigns its own
            # context id; the gate binds it to this chunk when the context's
            # TTSStartedFrame passes through (strict FIFO: one at a time).
            # Arm FIRST, queue SECOND: the loop is idle until the wait, so a
            # start-frame can only be seen after the chunk is armed.
            playback.chunk_index = index
            playback.awaiting_context = True
            playback.context_id = None
            playback.chunk_event = asyncio.Event()
            # `aggregated_by` is a required field of AggregatedTextFrame; the
            # value only labels the frame — one TTSTextFrame is one context.
            await self._task.queue_frame(TTSTextFrame(text=chunk, aggregated_by="sentence"))

            try:
                await asyncio.wait_for(playback.chunk_event.wait(), timeout=CHUNK_START_TIMEOUT_S)
            except asyncio.TimeoutError:
                pass
            if playback.awaiting_context and not self._closed and request.playback_id not in self._interrupted_ids:
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

            # chunk_played = "this chunk's audio was dispatched to the
            # transport". Strictly an over-report of what has left the
            # earpiece; HALO settles interrupted deliveries from these acks.
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
        self._interrupted_ids.discard(request.playback_id)

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

    async def _on_tts_audio(self, frame: TTSAudioRawFrame) -> None:
        playback = self._active
        if playback is None or playback.context_id != frame.context_id:
            return
        ms = _audio_ms(frame.audio, frame.sample_rate)
        playback.played_ms += ms
        self._outbound_audio_ms += ms
        if not playback.first_audio:
            playback.first_audio = True
            await self._client.playback_first_audio(playback.request.playback_id)

    async def _on_tts_stopped(self, frame: TTSStoppedFrame) -> None:
        playback = self._active
        if playback is None or playback.awaiting_context:
            return
        if playback.context_id != frame.context_id:
            return
        # The context drained: its audio is on its way to the transport.
        if playback.chunk_event is not None:
            playback.chunk_event.set()
        playback.context_id = None

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
        if not self._speaking:
            # The final arrived after VAD already endpointed (vendor finals
            # can lag the VAD event): this final IS the utterance end.
            await self._commit_utterance()

    async def _commit_utterance(self) -> None:
        finals, self._pending_finals = self._pending_finals, []
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
        self.first_audio = False
        self.settled = False
        self.chunk_index: Optional[int] = None
        self.context_id: Optional[str] = None
        self.awaiting_context = False
        self.chunk_event: Optional[asyncio.Event] = None


def _digit(button) -> str:
    value = getattr(button, "value", button)
    return str(value)[:4]


def _lang_str(language) -> Optional[str]:
    if language is None:
        return None
    return str(getattr(language, "value", language))[:16]


def _audio_ms(audio: bytes, sample_rate: int) -> float:
    if not audio or not sample_rate:
        return 0.0
    return (len(audio) / 2) * 1000.0 / sample_rate
