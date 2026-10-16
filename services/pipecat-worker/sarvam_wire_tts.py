"""Pinned Pipecat Sarvam wire-format adapter; no default model/codec selection.

Pipecat 0.0.108 ignores init-only codec params when Settings is supplied and
labels received bytes PCM16 even when requesting mu-law. Keep that vendor
quirk here, tag only this provider's frames, and correct their sample count.
"""
from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.services.sarvam.tts import SarvamTTSService

class SarvamWireTTSService(SarvamTTSService):
    def __init__(self, *, output_codec="linear16", **kwargs):
        if output_codec not in ("linear16", "mulaw"):
            raise ValueError("unsupported Sarvam wire codec")
        if output_codec == "mulaw":
            kwargs["push_silence_frames"] = False
        super().__init__(**kwargs)
        self._output_audio_codec = output_codec

    async def append_to_audio_context(self, context_id, frame):
        if self._output_audio_codec == "mulaw" and isinstance(frame, TTSAudioRawFrame):
            frame.metadata["halo_audio_encoding"] = "mulaw"
            frame.num_frames = len(frame.audio) // frame.num_channels
        await super().append_to_audio_context(context_id, frame)
