"""G.711 mu-law <-> PCM16 conversion.

STATUS: IMPLEMENTED, offline-tested. The algorithms are identical to
`packages/voice/audio.ts` (`mulawToLinear` / `linearToMulaw`), so both ends of
the media path agree bit for bit — what the caller said is what STT hears, and
what TTS produced is what the carrier carries.

Extracted from `halo_serializer.py` so the serializer stays a thin wire adapter
and tests can pin the codec without importing Pipecat at all.
"""

from __future__ import annotations

# The media contract: 8 kHz mono, mu-law. HALO's VoiceSession refuses anything
# else, and the fake carrier codec (`FakeMediaCodec`) hard-codes it too.
WIRE_SAMPLE_RATE = 8000

# mu-law companding is a byte-per-sample codec: no resampling is needed in
# either direction, and a "frame" is whatever the peer sent.
SAMPLE_WIDTH = 1

# Outbound pacing granularity: 480 μ-law bytes = 60 ms at 8 kHz, the packet
# size the fake carrier (and Twilio's media streams) stream at.
WIRE_CHUNK_BYTES = 480

# G.711 mu-law constants.
_ML_BIAS = 0x84
_ML_CLIP = 32635


def mulaw_to_pcm16(data: bytes) -> bytes:
    """Decode G.711 mu-law to PCM16 little-endian.

    Same algorithm as `mulawToLinear` in packages/voice/audio.ts.
    """
    out = bytearray(len(data) * 2)
    for i, byte in enumerate(data):
        u = ~byte & 0xFF
        sign = u & 0x80
        exponent = (u >> 4) & 0x07
        mantissa = u & 0x0F
        magnitude = (((mantissa << 3) + _ML_BIAS) << exponent) - _ML_BIAS
        value = -magnitude if sign else magnitude
        out[i * 2] = value & 0xFF
        out[i * 2 + 1] = (value >> 8) & 0xFF
    return bytes(out)


def pcm16_to_mulaw(data: bytes) -> bytes:
    """Encode PCM16 little-endian to G.711 mu-law.

    Same algorithm as `linearToMulaw` in packages/voice/audio.ts. A trailing
    odd byte (a split sample) is dropped rather than invented.
    """
    out = bytearray(len(data) // 2)
    for i in range(0, len(data) - 1, 2):
        sample = data[i] | (data[i + 1] << 8)
        if sample >= 0x8000:
            sample -= 0x10000
        sign = 0x80 if sample < 0 else 0x00
        if sample < 0:
            sample = -sample
        if sample > _ML_CLIP:
            sample = _ML_CLIP
        sample += _ML_BIAS
        exponent = 7
        mask = 0x4000
        while (sample & mask) == 0 and exponent > 0:
            mask >>= 1
            exponent -= 1
        mantissa = (sample >> (exponent + 3)) & 0x0F
        out[i // 2] = ~(sign | (exponent << 4) | mantissa) & 0xFF
    return bytes(out)
