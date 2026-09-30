"""HALO REST speech shim contract; does not load or claim to validate model weights."""
import base64
import io
import json
import wave
from datetime import datetime, timezone
from urllib.parse import urlparse
import aiohttp
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService


def endpoint(config, path):
    url = config.get("baseUrl", "")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Invalid deployment speech endpoint")
    return url.rstrip("/") + "/" + path


async def request(config, path, payload, max_bytes):
    headers = {"Authorization": "Bearer " + config["apiKey"]} if config.get("apiKey") else {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as client:
        async with client.post(endpoint(config, path), json=payload, headers=headers, allow_redirects=False) as response:
            if response.status != 200:
                raise RuntimeError("Speech provider rejected request")
            data = bytearray()
            async for chunk in response.content.iter_chunked(4096):
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise RuntimeError("Speech response exceeds limit")
            return bytes(data), response.headers


class SelfHostedSTT(SegmentedSTTService):
    def __init__(self, config, language, sample_rate):
        endpoint(config, "transcribe")
        super().__init__(sample_rate=sample_rate, settings=STTSettings(model=None, language=None))
        self.config = config
        self.language = language
        self._overflow = False

    async def process_audio_frame(self, frame, direction):
        if self._overflow:
            return
        if len(self._audio_buffer) + len(frame.audio) > self.sample_rate * 2 * 30:
            self._audio_buffer.clear()
            self._overflow = True
            await self.push_frame(ErrorFrame(error="Speech segment exceeds limit"))
            return
        await super().process_audio_frame(frame, direction)

    async def _handle_user_stopped_speaking(self, frame):
        if self._overflow:
            self._overflow = False
            self._user_speaking = False
            self._audio_buffer.clear()
            return
        await super()._handle_user_stopped_speaking(frame)

    async def run_stt(self, audio):
        try:
            with wave.open(io.BytesIO(audio), "rb") as wav:
                rate = wav.getframerate()
                if wav.getsampwidth() != 2 or wav.getnchannels() != 1 or wav.getnframes() > rate * 30:
                    raise ValueError("Invalid segmented speech audio")
                pcm = wav.readframes(wav.getnframes())
            data, _ = await request(self.config, "transcribe", {"audio": base64.b64encode(pcm).decode(),
                "format": {"encoding": "pcm16le", "sampleRate": rate, "channels": 1}, "language": self.language}, 16384)
            result = json.loads(data)
            text = result.get("text")
            if not isinstance(text, str) or len(text) > 4000:
                raise ValueError("Invalid transcription response")
            if text.strip():
                yield TranscriptionFrame(text=text, user_id="", timestamp=datetime.now(timezone.utc).isoformat(), language=None)
        except Exception:
            yield ErrorFrame(error="Self-hosted transcription unavailable")


class SelfHostedTTS(TTSService):
    def __init__(self, config, language, voice_id, speaking_rate, sample_rate):
        endpoint(config, "synthesize")
        super().__init__(sample_rate=sample_rate, push_start_frame=True, push_stop_frames=True,
                         settings=TTSSettings(model=None, voice=None, language=None))
        self.config, self.language = config, language
        self.voice_id, self.speaking_rate = voice_id, speaking_rate
        self.output_rate = sample_rate

    async def run_tts(self, text, context_id):
        try:
            rate = self.output_rate
            payload = {"text": text, "language": self.language,
                "format": {"encoding": "pcm16le", "sampleRate": rate, "channels": 1}}
            if self.voice_id:
                payload["voiceId"] = self.voice_id
            if self.speaking_rate:
                payload["speakingRate"] = self.speaking_rate
            data, headers = await request(self.config, "synthesize", payload, rate * 2 * 60)
            if headers.get("Content-Type", "").split(";")[0] != "audio/pcm" or int(headers.get("x-audio-sample-rate", "0")) != rate or len(data) % 2:
                raise ValueError("Invalid synthesis response")
            # No audio is exposed until the entire bounded response is valid.
            for offset in range(0, len(data), 4096):
                yield TTSAudioRawFrame(audio=data[offset:offset+4096], sample_rate=rate, num_channels=1, context_id=context_id)
        except Exception:
            yield ErrorFrame(error="Self-hosted synthesis unavailable")
