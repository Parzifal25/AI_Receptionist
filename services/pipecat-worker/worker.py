"""HALO Pipecat worker — the runnable media side of the Phase 4 integration.

STATUS: IMPLEMENTED. Offline-tested end to end over real WebSockets with fake
STT/TTS, and run live against Sarvam STT/TTS from a browser microphone client
(2026-10-06). It has never carried a real telephony provider's call, so no
PSTN quality or latency claim is made anywhere.

    telephony provider ──▶ media WS ──▶ this worker ──▶ control WS ──▶ HALO
    (μ-law 8 kHz)                    VAD ─ STT ─ TTS ─ GATE ─ pacer

Design notes
------------
*   One media socket, one pipeline, one control socket. The media server
    accepts a connection on /media; when it drops, the session ends.
*   All audio is μ-law 8 kHz on the wire (the wire contract) and PCM16 8 kHz
    in the pipeline: the pipeline rate IS the wire rate, so nothing resamples
    (Silero VAD supports 8 kHz natively; Sarvam STT/TTS take 8 kHz).
*   The gate (media_gate.py) sits between the TTS service and the output so
    it sees exactly the audio that will be sent to the caller and can
    attribute it to HALO's chunks.
*   The control socket is a CLIENT: the worker dials HALO after reading the
    media `start` parameters. `haloControlUrl`, `token`, `callId`, `from`,
    `to` arrive there — exactly the parameters HALO's gateway
    (services/voice-gateway/server.ts) puts in `start.parameters` when
    VOICE_MEDIA_ENGINE=pipecat.
*   The pipeline is assembled WITHOUT pipecat's transport layer: thin
    FrameProcessors at both ends bridge the raw media socket, and a pacer
    drains outbound audio in real time (TTS synthesizes faster than speech).
    On barge-in the pacer drops not-yet-sent audio out-of-band (the gate
    fires an interrupt listener the instant a playback is cut) and `clear`
    goes to the carrier — the same contract pipecat's own websocket output
    transport implements with its playout buffer.
*   The session waits for HALO's `ready` BEFORE running the pipeline: without
    identity the worker must not bridge audio, and the services are built
    from the voice config that `ready` carries.
*   Vendors: Sarvam STT/TTS with the deployment key (SARVAM_API_KEY); the
    in-process fakes only with an explicit HALO_SPEECH_PROVIDER=fake. The
    Sarvam path was run against the live service on 2026-10-06 (Telugu,
    English and Tenglish speech, barge-in) at the 8 kHz wire rate. The SDK
    types the streaming audio encoding as `audio/wav` only; the live endpoint
    accepts the pipeline's raw PCM16 under that label.
*   Besides a carrier, a browser may be the media peer: HALO's web server
    obtains the same token-bound `start` parameters from the gateway
    (`POST /web/call`) and the widget streams microphone audio here in the
    same wire format. Nothing in this worker distinguishes the two.

Running it
----------
    .venv/bin/python services/pipecat-worker/worker.py
    # env: HALO_WORKER_HOST (default 127.0.0.1), HALO_WORKER_PORT (default 8900)
    #      HALO_CONTROL_URL (trusted control socket), SARVAM_API_KEY,
    #      VOICE_STT_MODEL / VOICE_STT_MODE / VOICE_TTS_MODEL / VOICE_TTS_DEFAULT_VOICE
    #      (the same names the gateway reads), HALO_LOG_LEVEL (default INFO)

Tests: test_media_gate.py (gate semantics) and test_worker_e2e.py (the whole
loop over real WebSockets with fake vendors).
"""

from __future__ import annotations

import asyncio
from uuid import uuid4
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams, VADState
from pipecat.frames.frames import (
    Frame,
    EndFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
    TTSAudioRawFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams, PipelineTaskParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import STTSettings, TTSSettings
from websockets.asyncio.server import ServerConnection, serve

from halo_client import HaloControlClient, Handlers, VoiceConfig
from halo_codec import WIRE_SAMPLE_RATE
from halo_serializer import HaloMediaSerializer
from media_gate import MediaGate

log = logging.getLogger("halo.worker")

MEDIA_PATH = "/media"

# How long the worker waits on `start` / on HALO's `ready` before dropping
# the session. Both are handshakes, not media: nothing legitimate is slow here.
START_TIMEOUT_S = 30.0
READY_TIMEOUT_S = 15.0

# Serialize the teardown sequence with the socket writer.
TEARDOWN_TIMEOUT_S = 5.0

# Outbound pacing granularity: 60 ms of μ-law per media frame (the packet
# size the fake carrier, and Twilio's media streams, stream at).
PACE_CHUNK_S = 0.06


# ---------------------------------------------------------------------------
# Fake vendors — no credentials required
# ---------------------------------------------------------------------------


class FakeSTTService(STTService):
    """Scripted STT: emits scripted texts as finals at VAD utterance ends.

    The utterance boundaries come from real Silero VAD frames flowing through
    the pipeline (the gate sees the same frames), so the session shape —
    speech_started, speech_stopped, a held final committed at the endpoint —
    is exactly the real one. The audio content itself is not transcribed:
    there is nothing local to transcribe.
    """

    # The offline loop's one scripted line: the first caller utterance the
    # VAD endpoints produces this final. Exhausted after that — later
    # utterances produce no transcript, which keeps barge-in tests honest.
    DEFAULT_SCRIPT = ["\u0c28\u0c2e\u0c38\u0c4d\u0c15\u0c3e\u0c30\u0c02"]

    def __init__(self, *, script: Optional[list[str]] = None, **kwargs) -> None:
        super().__init__(settings=STTSettings(model=None, language=None), **kwargs)
        self._script = list(script if script is not None else self.DEFAULT_SCRIPT)
        self._index = 0
        self._active_text: Optional[str] = None

    async def run_stt(self, audio: bytes):
        # Audio is streamed through the base class; transcripts come from the
        # script below. There is nothing local to transcribe.
        yield None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStartedSpeakingFrame):
            if self._index < len(self._script):
                self._active_text = self._script[self._index]
                self._index += 1
            else:
                self._active_text = None
        elif isinstance(frame, VADUserStoppedSpeakingFrame) and self._active_text:
            text, self._active_text = self._active_text, None

            async def emit(text=text):
                yield TranscriptionFrame(text=text, user_id="", timestamp=datetime.now(timezone.utc).isoformat(), language=None)

            await self.process_generator(emit())


class FakeTTSService(TTSService):
    """Beep TTS: 440 Hz for 60 ms per character (max 2 s) — audible, countable,
    and long enough that a chunk can span a caller barge-in.

    It yields its audio synchronously inside run_tts, so it relies on the
    base class to create the audio context and emit TTSStarted/StoppedFrame:
    push_start_frame/push_stop_frames must be on (streaming vendors manage
    their own contexts and leave them off).
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, settings=TTSSettings(model=None, voice=None, language=None), **kwargs)

    async def run_tts(self, text: str, context_id: str):
        import math

        rate = self.sample_rate
        seconds = min(2.0, 0.06 * max(1, len(text)))
        n = int(rate * seconds)
        samples = bytearray()
        for i in range(n):
            value = int(16000 * math.sin(2 * math.pi * 440 * (i / rate)))
            samples += value.to_bytes(2, "little", signed=True)
        yield TTSAudioRawFrame(
            audio=bytes(samples), sample_rate=rate, num_channels=1, context_id=context_id
        )


def _pipecat_language(code: Optional[str]):
    if not code:
        return None
    from pipecat.transcriptions.language import Language

    try:
        return Language(code)
    except ValueError:
        log.warning("unknown language code %r; letting the vendor auto-detect", code)
        return None


def _sarvam_key(selected: dict) -> str:
    """Profile credential first, then the deployment key the gateway also reads."""
    return str(selected.get("apiKey") or os.environ.get("SARVAM_API_KEY") or os.environ.get("SARVAM_API") or "").strip()


def _build_stt(voice: VoiceConfig, script: Optional[list[str]], profile=None):
    """Deployment-selected speech; fake transcripts require explicit test mode."""
    selected = (profile or {}).get("stt", {})
    api_key = _sarvam_key(selected)
    provider = selected.get("provider", os.environ.get("HALO_SPEECH_PROVIDER", "sarvam"))
    if provider == "sarvam" and not api_key and selected.get("fallback"):
        selected = selected["fallback"]
        provider = selected.get("provider")
        api_key = selected.get("apiKey", "")
    if provider not in ("fake", "sarvam"):
        raise RuntimeError("Unsupported STT profile provider")
    if provider == "fake":
        return FakeSTTService(script=script)
    if not api_key:
        raise RuntimeError("Sarvam STT is not configured; fake speech is disabled")
    from pipecat.services.sarvam.stt import SarvamSTTService

    # Same deployment settings the gateway reads (services/voice-gateway/config.ts).
    model = selected.get("model") or os.environ.get("VOICE_STT_MODEL") or os.environ.get("HALO_STT_MODEL", "saarika:v2.5")
    # `mode` is a constructor argument that only some models accept, so it is
    # passed only when the deployment configured one.
    mode = selected.get("mode") or os.environ.get("VOICE_STT_MODE")
    # The agent's primary language is pinned. Live Sarvam runs showed vendor
    # auto-detection mishearing a short Telugu greeting as Hindi, while a
    # pinned te-IN session still transcribed English and Tenglish correctly
    # (use VOICE_STT_MODEL=saaras:v3 with VOICE_STT_MODE=codemix to keep
    # English words in Latin script).
    language = _pipecat_language(voice.language)
    return SarvamSTTService(
        api_key=api_key,
        settings=SarvamSTTService.Settings(model=model, language=language),
        sample_rate=WIRE_SAMPLE_RATE,
        # input_audio_codec stays the SDK default ("wav"): the SDK's message
        # type accepts no other label, and the live endpoint takes the
        # pipeline's headerless PCM16 under it.
        **({"mode": mode} if mode else {}),
    )


def _build_tts(voice: VoiceConfig, profile=None):
    """Deployment-selected speech; synthetic tones require explicit test mode."""
    selected = (profile or {}).get("tts", {})
    api_key = _sarvam_key(selected)
    provider = selected.get("provider", os.environ.get("HALO_SPEECH_PROVIDER", "sarvam"))
    if provider == "sarvam" and not api_key and selected.get("fallback"):
        selected = selected["fallback"]
        provider = selected.get("provider")
        api_key = selected.get("apiKey", "")
    if provider not in ("fake", "sarvam"):
        raise RuntimeError("Unsupported TTS profile provider")
    if provider == "fake":
        return FakeTTSService()
    if not api_key:
        raise RuntimeError("Sarvam TTS is not configured; fake speech is disabled")
    from pipecat.services.sarvam.tts import SarvamTTSService

    settings_kwargs: dict[str, Any] = {
        "model": selected.get("model") or os.environ.get("VOICE_TTS_MODEL") or os.environ.get("HALO_TTS_MODEL", "bulbul:v2"),
        "language": _pipecat_language(voice.language),
    }
    # Agent voice, then the profile's, then the deployment default the gateway
    # requires (VOICE_TTS_DEFAULT_VOICE). The worker never picks one itself.
    speaker = voice.voice_id or selected.get("defaultSpeaker") or os.environ.get("VOICE_TTS_DEFAULT_VOICE")
    if speaker:
        settings_kwargs["voice"] = speaker
    if voice.speaking_rate:
        settings_kwargs["pace"] = float(voice.speaking_rate)
    return SarvamTTSService(
        api_key=api_key,
        settings=SarvamTTSService.Settings(**settings_kwargs),
        sample_rate=WIRE_SAMPLE_RATE,
    )


def _build_vad(voice: VoiceConfig) -> SileroVADAnalyzer:
    """Silero at the wire rate, endpointed from HALO's config."""
    params = VADParams()
    if voice.vad_end_hangover_ms:
        params.stop_secs = voice.vad_end_hangover_ms / 1000.0
    return SileroVADAnalyzer(sample_rate=WIRE_SAMPLE_RATE, params=params)


# ---------------------------------------------------------------------------
# Thin media-path processors
# ---------------------------------------------------------------------------


class MediaSource(FrameProcessor):
    """Pipeline source: forwards frames queued by the media reader."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)


class VadRunner(FrameProcessor):
    """Runs the VAD analyzer over inbound audio and emits VAD event frames.

    Pipecat's transports normally do this inside the input transport; with no
    transport in the pipeline, this processor is the VAD driver: audio in,
    VADUserStarted/StoppedSpeakingFrame + the audio frame out (VAD frames
    first, matching the ordering of pipecat's input transport, so STT sees
    the endpoint before or with the audio that produced it).
    """

    def __init__(self, vad: SileroVADAnalyzer) -> None:
        super().__init__()
        self._vad = vad
        self._state = VADState.QUIET

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            # The input transport normally does this; with no transport, we do.
            self._vad.set_sample_rate(frame.audio_in_sample_rate)
        if isinstance(frame, InputAudioRawFrame):
            state = await self._vad.analyze_audio(frame.audio)
            if state != self._state:
                if state == VADState.SPEAKING:
                    await self.push_frame(VADUserStartedSpeakingFrame())
                elif state == VADState.QUIET:
                    await self.push_frame(VADUserStoppedSpeakingFrame())
                self._state = state
        await self.push_frame(frame, direction)


class MediaSink(FrameProcessor):
    """Pipeline sink: hands outbound frames to the pacer AND to the pipeline.

    Frames are queued for the pacer (which serializes them — PCM16 → μ-law,
    wire-sized `media` frames, `clear` on interruption — and paces them to the
    media socket) and ALSO pushed through: pipecat's pipeline sink watches the
    stream for lifecycle frames (StartFrame completes pipeline start, EndFrame
    stops the task). Swallowing frames here would hang the task forever.
    """

    def __init__(self) -> None:
        super().__init__()
        self.outgoing: asyncio.Queue[Frame] = asyncio.Queue()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            self.outgoing.put_nowait(frame)
            await self.push_frame(frame, direction)


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------


class HaloWorkerSession:
    """One media connection == one call == one pipeline == one control socket."""

    def __init__(self, socket: ServerConnection) -> None:
        self._socket = socket
        self._serializer: Optional[HaloMediaSerializer] = None
        self._start_params: dict[str, Any] = {}
        self._control: Optional[HaloControlClient] = None
        self._control_socket: Any = None
        self._gate: Optional[MediaGate] = None
        self._task: Optional[PipelineTask] = None
        self._sink = MediaSink()
        self._reader_task: Optional[asyncio.Task] = None
        self._pacer_task: Optional[asyncio.Task] = None
        self._voice: Optional[VoiceConfig] = None
        self._speech_profile = None
        self._audio_generation = 0
        self._playout_marks = {}
        self._ready: asyncio.Future = asyncio.get_event_loop().create_future()
        self._media_closed = asyncio.Event()
        self._send_lock = asyncio.Lock()

    async def run(self) -> None:
        """Accept the media socket, run one session, clean up after it."""
        try:
            start_raw = await asyncio.wait_for(self._recv_start(), timeout=START_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("media socket sent no start event; dropping")
            return
        if not isinstance(start_raw, dict) or start_raw.get("event") != "start":
            log.warning("first media frame was not `start`; dropping")
            return
        try:
            self._serializer = HaloMediaSerializer(start_event=start_raw)
        except ValueError:
            log.warning("invalid carrier start frame; refusing session")
            return
        self._start_params = dict(self._serializer.parameters)
        log.info(
            "media start call=%s stream=%s",
            self._start_params.get("callId", ""),
            start_raw.get("streamId", ""),
        )

        control_url = os.environ.get("HALO_CONTROL_URL", "")
        requested_url = self._start_params.get("haloControlUrl", "")
        if not control_url or requested_url != control_url:
            # Without a control plane there is nothing this worker may do:
            # no ready, no speak commands, no tenant content. Dead air and an
            # honest log are the only correct behaviour.
            log.error("media control URL does not match trusted HALO_CONTROL_URL; refusing session")
            return

        try:
            await self._run_session(str(control_url))
        except Exception:
            log.exception("session crashed")
            if self._control:
                await self._control.error("pipeline", "configuration_or_provider_failure", False)
        finally:
            await self._teardown()

    # -- handshakes ---------------------------------------------------------

    async def _recv_start(self) -> Any:
        frame = await self._recv_json()
        if isinstance(frame, dict) and frame.get("event") == "connected":
            frame = await self._recv_json()
        return frame

    async def _recv_json(self) -> Any:
        import json

        async for raw in self._socket:
            if isinstance(raw, bytes):
                continue  # the protocol is text frames only
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
        return None

    async def _run_session(self, control_url: str) -> None:
        import websockets

        params = self._start_params
        # The worker never chooses identity: these are the values the token
        # was minted over, relayed verbatim from the media start parameters.
        self._control_socket = await websockets.connect(control_url)
        self._control = HaloControlClient(
            self._control_socket,
            provider_call_id=str(params.get("callId", "")),
            from_number=str(params.get("from", "")),
            to_number=str(params.get("to", "")),
            token=str(params.get("token", "")),
            handlers=Handlers(
                on_ready=self._on_ready,
                on_speak=self._on_speak,
                on_stop_playback=self._on_stop_playback,
                on_hangup=self._on_hangup,
            ),
            worker="pipecat-halo-worker",
        )
        self._gate = MediaGate(self._control)
        self._gate.set_playout_waiter(self._wait_for_playout)

        control_task = asyncio.create_task(self._control.run())
        try:
            voice = await asyncio.wait_for(self._ready, timeout=READY_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.error("HALO never sent `ready` (bad token?); refusing to bridge audio")
            control_task.cancel()
            return
        self._voice = voice

        # The pipeline starts only now: services are built from HALO's voice
        # config, so no settings-update dance is needed mid-flight.
        pipeline = Pipeline(
            [
                MediaSource(),
                VadRunner(_build_vad(voice)),
                _build_stt(voice, script=None, profile=self._speech_profile),
                _build_tts(voice, profile=self._speech_profile),
                self._gate,
                self._sink,
            ]
        )
        self._task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=True,
                audio_in_sample_rate=WIRE_SAMPLE_RATE,
                audio_out_sample_rate=WIRE_SAMPLE_RATE,
            ),
            # No RTVI client dials into this worker; the control plane is
            # HALO's protocol, not RTVI.
            enable_rtvi=False,
            # A quiet caller is not a dead worker; HALO's max_call_duration
            # watchdog bounds the call, not pipecat's idle heuristic.
            idle_timeout_secs=None,
        )
        self._gate.bind_task(self._task)
        self._gate.add_interrupt_listener(self._drop_buffered_audio)

        self._reader_task = asyncio.create_task(self._read_media())
        self._pacer_task = asyncio.create_task(self._pace_outbound())
        run_task = asyncio.create_task(
            self._task.run(PipelineTaskParams(loop=asyncio.get_running_loop()))
        )

        done, pending = await asyncio.wait(
            {
                run_task,
                control_task,
                asyncio.ensure_future(self._media_closed.wait()),
            },
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            if task is not run_task:
                task.cancel()

        # Graceful pipeline stop, then hard cancel as a backstop.
        if not run_task.done():
            try:
                await self._task.queue_frame(EndFrame())
                await asyncio.wait_for(run_task, timeout=TEARDOWN_TIMEOUT_S)
            except Exception:
                log.warning("pipeline did not stop cleanly; cancelling")
                run_task.cancel()

    # -- control-plane handlers (delegating to the gate) ---------------------

    async def _on_ready(self, identity, voice: VoiceConfig) -> None:
        if voice.profile_id:
            import json
            profiles = json.loads(os.environ.get("VOICE_PROFILES_JSON", "{}"))
            profile = profiles.get(identity.tenant_id, {}).get(voice.profile_id)
            if not isinstance(profile, dict) or profile.get("sampleRate") != WIRE_SAMPLE_RATE:
                raise RuntimeError("Tenant speech profile unavailable for transport")
            self._speech_profile = profile
        if not self._ready.done():
            self._ready.set_result(voice)
        if self._gate is not None:
            await self._gate.on_ready(identity, voice)

    async def _on_speak(self, request) -> None:
        if self._gate is not None:
            await self._gate.on_speak(request)

    async def _on_stop_playback(self, playback_id: str, reason: str) -> None:
        if self._gate is not None:
            await self._gate.on_stop_playback(playback_id, reason)

    async def _on_hangup(self, reason: str) -> None:
        if self._gate is not None:
            await self._gate.on_hangup(reason)

    # -- media reading and pacing ---------------------------------------------

    async def _read_media(self) -> None:
        """Read the media socket until it drops, queueing pipecat frames."""
        try:
            async for raw in self._socket:
                if isinstance(raw, bytes):
                    continue  # the protocol is text frames only
                if self._serializer is None:
                    continue
                import json
                try:
                    message = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if not isinstance(message, dict):
                    continue
                if self._serializer.twilio and message.get("streamSid") != self._serializer.stream_id:
                    continue
                if message.get("event") == "stop":
                    return
                name = self._serializer.decode_mark(message)
                if name:
                    pending = self._playout_marks.get(name)
                    if pending is not None and not pending.done():
                        pending.set_result(True)
                    continue
                frame = await self._serializer.deserialize(raw)
                if frame is not None and self._task is not None:
                    await self._task.queue_frame(frame)
        except Exception:
            log.exception("media reader failed")
        finally:
            self._media_closed.set()

    async def _pace_outbound(self) -> None:
        """Drain the sink and send at speaking speed.

        TTS produces audio faster than real time, so the queue buffers; the
        pacer sends 60 ms wire chunks spaced 60 ms apart. `clear` is sent
        out-of-band by _drop_buffered_audio on barge-in; the InterruptionFrame
        itself is not serialized (it would be a no-op on the wire anyway).
        """
        try:
            while True:
                frame = await self._sink.outgoing.get()
                if isinstance(frame, tuple) and frame[0] == "halo_mark":
                    _, name, generation = frame
                    if generation == self._audio_generation and name in self._playout_marks and self._serializer:
                        async with self._send_lock:
                            await self._socket.send(self._serializer.encode_mark(name))
                elif isinstance(frame, OutputAudioRawFrame):
                    await self._send_audio(frame)
                else:
                    # Non-audio frames are pipeline-internal, with one
                    # exception: the serializer maps InterruptionFrame to
                    # `clear` on the wire — the carrier must drop its playout
                    # buffer. Everything else serializes to None.
                    if self._serializer is None:
                        continue
                    try:
                        text = await self._serializer.serialize(frame)
                    except Exception:
                        continue
                    if text is not None:
                        try:
                            async with self._send_lock:
                                await self._socket.send(text)
                        except Exception:
                            log.info("media socket gone during send")
        except asyncio.CancelledError:
            pass

    async def _wait_for_playout(self, playback_id: str, chunk_index: int) -> bool:
        name = "halo-" + uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._playout_marks[name] = future
        self._sink.outgoing.put_nowait(("halo_mark", name, self._audio_generation))
        try:
            return await asyncio.wait_for(future, timeout=45)
        finally:
            self._playout_marks.pop(name, None)

    def _drop_buffered_audio(self) -> None:
        """Cut queued AND currently paced audio; invalidate all pending marks."""
        self._audio_generation += 1
        for future in self._playout_marks.values():
            if not future.done():
                future.set_result(False)
        self._playout_marks.clear()
        while True:
            try:
                stale = self._sink.outgoing.get_nowait()
            except asyncio.QueueEmpty:
                return
            # Nothing else to do: every queued frame is audio by construction.

    async def _send_audio(self, frame: OutputAudioRawFrame) -> None:
        """Serialize to μ-law, cut into wire frames, pace, and send."""
        if self._serializer is None or not frame.audio:
            return
        try:
            messages = self._serializer._serialize_audio(frame.audio)
        except Exception:
            log.exception("audio serialization failed")
            return
        if not messages:
            return
        generation = self._audio_generation
        for message in messages:
            if generation != self._audio_generation:
                return
            try:
                async with self._send_lock:
                    await self._socket.send(message)
            except Exception:
                log.info("media socket gone during send")
                return
            await asyncio.sleep(PACE_CHUNK_S)

    # -- teardown ----------------------------------------------------------------

    async def _teardown(self) -> None:
        for task in (self._reader_task, self._pacer_task):
            if task is not None and not task.done():
                task.cancel()
        if self._gate is not None:
            try:
                await asyncio.wait_for(self._gate.close("transport_closed"), timeout=2.0)
            except Exception:
                pass
        if self._control is not None:
            await self._control.close()
        if self._control_socket is not None:
            try:
                await self._control_socket.close()
            except Exception:
                pass
        try:
            await self._socket.close()
        except Exception:
            pass
        log.info("session ended")


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


async def _handler(socket: ServerConnection) -> None:
    request = getattr(socket, "request", None)
    path = str(getattr(request, "path", "") or "")
    if not path.startswith(MEDIA_PATH):
        await socket.close(code=1008, reason="not found")
        return
    await HaloWorkerSession(socket).run()


async def main() -> None:
    host = os.environ.get("HALO_WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("HALO_WORKER_PORT", "8900"))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    import signal

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover - non-unix
            pass
    async with serve(_handler, host, port):
        log.info("HALO pipecat worker listening on ws://%s:%s%s", host, port, MEDIA_PATH)
        await stop.wait()
    log.info("worker stopped")


if __name__ == "__main__":
    # Pipecat logs through loguru at DEBUG by default, which prints caller
    # transcripts and every line HALO speaks. Hold it to the worker's level.
    import sys
    from loguru import logger as pipecat_log

    pipecat_log.remove()
    pipecat_log.add(sys.stderr, level=os.environ.get("HALO_LOG_LEVEL", "INFO"))
    logging.basicConfig(
        level=os.environ.get("HALO_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    asyncio.run(main())
