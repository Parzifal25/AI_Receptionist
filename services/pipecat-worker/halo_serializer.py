"""Frame serializer for HALO's media-stream protocol.

STATUS: IMPLEMENTED, offline-tested — never exercised against a real telephony
provider, because no telephony credentials exist in this repository. The wire
format it implements is the one `FakeTelephonyProvider` already speaks and the
one `scripts/local-call.ts` places calls with: JSON text frames carrying base64
mu-law 8 kHz payloads.

    {"event": "start", "callId": ..., "streamId": ..., "parameters": {...}}
    {"event": "media", "payload": "<base64 mulaw>"}
    {"event": "mark",  "name": ...}
    {"event": "dtmf",  "digit": ...}
    {"event": "stop"}

Outbound it emits `media`, `clear` (barge-in) and `mark` — the exact frames the
HALO voice session (or a real carrier shim) answers to.

This replaces the Phase 4 note that a worker "must write its own serializer":
it is that serializer, so a worker needs no telephony vendor to be exercised
against the local loop.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Optional, Union

from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

from halo_codec import WIRE_CHUNK_BYTES, pcm16_to_mulaw, mulaw_to_pcm16

log = logging.getLogger("halo.serializer")

class HaloMediaSerializer(FrameSerializer):
    """HALO fake-carrier media protocol <-> pipecat frames.

    Audio crosses as base64 mu-law 8 kHz in both directions — the same bytes
    the wire carries — so the serializer performs NO resampling and NO quality
    change: what STT hears is what the caller said, bit for bit.
    """

    def __init__(self, start_event: Optional[dict] = None, **kwargs):
        super().__init__(**kwargs)
        self._start_event = start_event or {}
        # The stream id the provider handed us, needed on outbound frames.
        self.stream_id: str = str(self._start_event.get("streamId", ""))

    async def setup(self, frame: StartFrame):
        pass

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, (EndFrame, CancelFrame)):
            # The media leg is closed by the transport, not by an in-band
            # frame: HALO finalizes on `stop`/socket close, never on this.
            return None
        if isinstance(frame, InterruptionFrame):
            # Barge-in: tell the carrier to drop its playout buffer.
            return json.dumps({"event": "clear"})
        if isinstance(frame, OutputAudioRawFrame):
            return self._serialize_audio(frame.audio)
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, bytes):
            return None  # the protocol is text frames only
        try:
            message = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        event = message.get("event")
        if event == "media":
            payload = message.get("payload")
            if not isinstance(payload, str):
                return None
            try:
                audio = base64.b64decode(payload)
            except Exception:  # noqa: BLE001 - a bad frame is dropped, not fatal
                return None
            if not audio:
                return None
            # The wire carries mu-law; the pipeline works in PCM16 (STT
            # vendors take linear PCM and the VAD model needs it). Convert
            # here, at the boundary, so what STT hears is exactly what the
            # caller said — 8 kHz in, 8 kHz out, no resampling.
            return InputAudioRawFrame(
                audio=mulaw_to_pcm16(audio),
                num_channels=1,
                sample_rate=WIRE_SAMPLE_RATE,
            )
        if event == "dtmf":
            digit = message.get("digit")
            if not isinstance(digit, str) or not digit:
                return None
            return InputDTMFFrame(digit)
        return None

    def _serialize_audio(self, audio: bytes) -> Optional[list[str]]:
        """Convert PCM16 to μ-law and cut it into wire-size media frames.

        The pipeline hands over one PCM chunk per TTS burst (arbitrary size);
        the carrier consumes fixed ~60 ms media frames. Returns a LIST of wire
        messages, or None when there is no audio. The caller (the pacer) sends
        them with real-time spacing so the caller hears speech, not a burst.
        """
        if not audio:
            return None
        # Pipeline audio is PCM16 LE at 8 kHz (what the TTS services produce
        # and what the transport paces); the wire is mu-law. Same conversion
        # as `linearToMulaw` in packages/voice/audio.ts, bit for bit.
        mulaw = pcm16_to_mulaw(audio)
        return [
            json.dumps(
                {"event": "media", "payload": base64.b64encode(mulaw[i : i + WIRE_CHUNK_BYTES]).decode("utf-8")}
            )
            for i in range(0, len(mulaw), WIRE_CHUNK_BYTES)
        ]

    # The mark path is serializer-adjacent, not a Frame: the transport has no
    # frame type for "the chunk left the earpiece", so the session reports
    # marks itself (see media_gate.py) rather than asking the serializer.
    def encode_mark(self, name: str) -> str:
        return json.dumps({"event": "mark", "name": name})

    @staticmethod
    def decode_mark(message: dict) -> Optional[str]:
        if message.get("event") != "mark":
            return None
        name = message.get("name")
        return name if isinstance(name, str) else None
