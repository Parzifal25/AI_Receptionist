"""HALO control-plane client for a Pipecat worker.

STATUS: REFERENCE IMPLEMENTATION — **NOT VERIFIED**.

This file has never been run against a real telephony provider, a real STT or
TTS vendor, or a real Pipecat pipeline, because no credentials for any of
them exist in this repository. It is written to the protocol that the HALO
side implements and tests (`packages/voice/pipecat/protocol.ts`, exercised
end to end over a real WebSocket in `tests/integration/pipecat-gateway.test.ts`),
so the WIRE FORMAT is pinned by tests on one side only. Treat every behaviour
here as a hypothesis until a real call has been placed.

What this client is responsible for, and what it must never do:

  It OWNS   the media pipeline: transport, VAD, STT, TTS, and cutting
            playback the instant the caller speaks. Interruption is local
            precisely so it costs no round trip.
  It REPORTS what happened: speech started/stopped, transcripts, which reply
            chunks actually played, and why playback ended.
  It OBEYS  `speak`, `stop_playback` and `hangup`.
  It NEVER  decides which tenant or agent a call belongs to, holds tenant
            content, synthesises a line HALO did not send, performs a
            transfer, or hangs up on its own authority. Identity arrives in
            `ready` and is used for logging only.

Separation of concerns: this module is transport and protocol. It has no
Pipecat imports, so it can be unit-tested without a media stack.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger("halo.client")

PROTOCOL_VERSION = "1.0"

# One control frame is small; anything larger is not a control frame.
MAX_FRAME_BYTES = 32 * 1024


@dataclass(frozen=True)
class SessionIdentity:
    """Server-resolved identity for one call. Logging and correlation only."""

    tenant_id: str
    agent_id: str
    agent_version_id: str
    agent_version: int
    call_id: str
    session_id: str
    conversation_id: str
    correlation_id: str

    @staticmethod
    def from_json(payload: dict[str, Any]) -> "SessionIdentity":
        return SessionIdentity(
            tenant_id=payload["tenantId"],
            agent_id=payload["agentId"],
            agent_version_id=payload["agentVersionId"],
            agent_version=int(payload["agentVersion"]),
            call_id=payload["callId"],
            session_id=payload["sessionId"],
            conversation_id=payload["conversationId"],
            correlation_id=payload["correlationId"],
        )


@dataclass(frozen=True)
class VoiceConfig:
    """Media parameters. Carries no tenant-authored speech, by design."""

    language: str
    alternative_languages: list[str]
    phrase_hints: list[str]
    vad_min_speech_ms: int
    vad_end_hangover_ms: int
    barge_in_enabled: bool
    barge_in_min_speech_ms: int
    max_call_duration_ms: int
    voice_id: Optional[str] = None
    speaking_rate: Optional[float] = None

    @staticmethod
    def from_json(payload: dict[str, Any]) -> "VoiceConfig":
        vad = payload.get("vad", {})
        barge = payload.get("bargeIn", {})
        return VoiceConfig(
            language=payload["language"],
            alternative_languages=list(payload.get("alternativeLanguages", [])),
            phrase_hints=list(payload.get("phraseHints", [])),
            vad_min_speech_ms=int(vad.get("minSpeechMs", 120)),
            vad_end_hangover_ms=int(vad.get("endHangoverMs", 700)),
            barge_in_enabled=bool(barge.get("enabled", True)),
            barge_in_min_speech_ms=int(barge.get("minSpeechMs", 250)),
            max_call_duration_ms=int(payload.get("maxCallDurationMs", 900_000)),
            voice_id=payload.get("voiceId"),
            speaking_rate=payload.get("speakingRate"),
        )


@dataclass
class SpeakRequest:
    """A line HALO wants the caller to hear, already split into chunks."""

    playback_id: str
    kind: str  # "reply" | "policy"
    turn_id: Optional[str]
    chunks: list[str]
    interruptible: bool


@dataclass
class Handlers:
    """Everything the media pipeline must provide. All are awaited."""

    on_ready: Callable[[SessionIdentity, VoiceConfig], Awaitable[None]]
    on_speak: Callable[[SpeakRequest], Awaitable[None]]
    on_stop_playback: Callable[[str, str], Awaitable[None]]
    on_hangup: Callable[[str], Awaitable[None]]


class HaloControlClient:
    """One control socket for one call.

    `connection` is any object with async `send(str)`, async `recv() -> str`
    and async `close()` — a `websockets` client connection satisfies it. It is
    injected rather than created so this class can be tested without a server.
    """

    def __init__(
        self,
        connection: Any,
        *,
        provider_call_id: str,
        from_number: str,
        to_number: str,
        token: str,
        handlers: Handlers,
        worker: str = "pipecat-reference",
    ) -> None:
        self._conn = connection
        self._provider_call_id = provider_call_id
        self._from = from_number
        self._to = to_number
        self._token = token
        self._handlers = handlers
        self._worker = worker
        self._identity: Optional[SessionIdentity] = None
        self._closed = False
        self._send_lock = asyncio.Lock()

    @property
    def identity(self) -> Optional[SessionIdentity]:
        return self._identity

    # -- outbound -----------------------------------------------------------

    async def hello(self) -> None:
        """Presents the token HALO minted during the verified webhook.

        The worker does not choose `from`/`to`: they are the values the token
        was signed over, handed to it in the stream parameters. Changing
        either one makes the token fail, which is what stops a worker opening
        a session against another tenant's number.
        """
        await self._send(
            {
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "providerCallId": self._provider_call_id,
                "from": self._from,
                "to": self._to,
                "token": self._token,
                "worker": self._worker,
            }
        )

    async def speech_started(self) -> None:
        await self._send({"type": "speech_started"})

    async def speech_stopped(self) -> None:
        await self._send({"type": "speech_stopped"})

    async def transcript(
        self,
        text: str,
        *,
        final: bool,
        utterance_id: Optional[str] = None,
        language: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> None:
        """Reports what STT heard.

        `confidence` is sent only when the vendor actually reported one.
        Never invent a number here: HALO uses a low confidence to decide
        whether to read a value back to the caller, and a fabricated 0.9
        silently disables that.
        """
        frame: dict[str, Any] = {
            "type": "transcript",
            "final": final,
            "text": text[:2000],
            "language": language,
            "confidence": confidence,
        }
        if utterance_id is not None:
            # Stable per utterance, so a re-sent final is de-duplicated
            # rather than answered twice.
            frame["utteranceId"] = utterance_id
        await self._send(frame)

    async def playback_first_audio(self, playback_id: str) -> None:
        await self._send({"type": "playback", "playbackId": playback_id, "phase": "first_audio"})

    async def playback_chunk_played(self, playback_id: str, chunk_index: int) -> None:
        """One chunk finished playing OUT of the caller's earpiece.

        Not "finished synthesising" and not "finished sending": HALO records
        this as what the caller actually heard, and an interrupted reply is
        written to the transcript from exactly these acknowledgements.
        """
        await self._send(
            {
                "type": "playback",
                "playbackId": playback_id,
                "phase": "chunk_played",
                "chunkIndex": chunk_index,
            }
        )

    async def playback_stopped(
        self, playback_id: str, reason: str, *, audio_ms: Optional[float] = None
    ) -> None:
        frame: dict[str, Any] = {
            "type": "playback",
            "playbackId": playback_id,
            "phase": "stopped",
            "reason": reason,
        }
        if audio_ms is not None:
            frame["audioMs"] = audio_ms
        await self._send(frame)

    async def dtmf(self, digit: str) -> None:
        await self._send({"type": "dtmf", "digit": digit})

    async def usage(self, inbound_audio_ms: float, outbound_audio_ms: float, tts_characters: int) -> None:
        await self._send(
            {
                "type": "usage",
                "inboundAudioMs": inbound_audio_ms,
                "outboundAudioMs": outbound_audio_ms,
                "ttsCharacters": tts_characters,
            }
        )

    async def error(self, component: str, code: str, retryable: bool) -> None:
        await self._send({"type": "error", "component": component, "code": code, "retryable": retryable})

    async def bye(self, reason: str) -> None:
        await self._send({"type": "bye", "reason": reason})

    # -- inbound ------------------------------------------------------------

    async def run(self) -> None:
        """Reads commands until the socket closes. Never raises on a bad frame."""
        await self.hello()
        while not self._closed:
            try:
                raw = await self._conn.recv()
            except Exception:  # noqa: BLE001 - any transport failure ends the call
                log.info("halo control socket closed")
                return
            if isinstance(raw, bytes):
                # Audio never crosses this socket.
                continue
            if len(raw) > MAX_FRAME_BYTES:
                log.warning("oversized control frame ignored")
                continue
            try:
                command = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("unparsable control frame ignored")
                continue
            await self._dispatch(command)

    async def _dispatch(self, command: dict[str, Any]) -> None:
        kind = command.get("type")
        if kind == "ready":
            self._identity = SessionIdentity.from_json(command["session"])
            voice = VoiceConfig.from_json(command["voice"])
            log.info(
                "session ready call=%s correlation=%s language=%s",
                self._identity.call_id,
                self._identity.correlation_id,
                voice.language,
            )
            await self._handlers.on_ready(self._identity, voice)
            return
        if kind == "speak":
            await self._handlers.on_speak(
                SpeakRequest(
                    playback_id=command["playbackId"],
                    kind=command.get("kind", "reply"),
                    turn_id=command.get("turnId"),
                    chunks=list(command.get("chunks", [])),
                    interruptible=bool(command.get("interruptible", True)),
                )
            )
            return
        if kind == "stop_playback":
            await self._handlers.on_stop_playback(command["playbackId"], command.get("reason", ""))
            return
        if kind == "hangup":
            self._closed = True
            await self._handlers.on_hangup(command.get("reason", ""))
            return
        log.warning("unknown command ignored: %s", kind)

    async def close(self) -> None:
        self._closed = True
        try:
            await self._conn.close()
        except Exception:  # noqa: BLE001
            pass

    async def _send(self, frame: dict[str, Any]) -> None:
        if self._closed:
            return
        async with self._send_lock:
            try:
                await self._conn.send(json.dumps(frame, ensure_ascii=False))
            except Exception:  # noqa: BLE001
                # The call is already ending; dropping a report is correct.
                self._closed = True
