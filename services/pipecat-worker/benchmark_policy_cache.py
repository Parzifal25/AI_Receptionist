"""W4.9 synthetic actual-gate cache and bit-exact serializer CPU benchmark."""
import asyncio
import json
import statistics
import time
from test_media_gate import MediaGateTests, pcm, RATE
from test_speech_minimums import IDENTITY, voice
from halo_client import SpeakRequest
from halo_serializer import HaloMediaSerializer
from halo_codec import pcm16_to_mulaw
from pipecat.frames.frames import TTSSpeakFrame, TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

def summary(rows):
    rows = sorted(rows)
    return {'n': len(rows), 'p50': round(statistics.median(rows), 3), 'p95': round(rows[int(.95*len(rows))-1], 3), 'max': round(max(rows), 3)}

async def pair():
    h = MediaGateTests(); await h.asyncSetUp()
    await h.gate.on_ready(IDENTITY, voice())
    tasks = []
    async def synth(frame):
        await asyncio.sleep(.03)
        ctx = str(id(frame))
        await h.gate.process_frame(TTSStartedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
        await h.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id=ctx), FrameDirection.DOWNSTREAM)
        await h.gate.process_frame(TTSStoppedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
    async def queue(frame):
        h.task.frames.append(frame)
        if isinstance(frame, TTSSpeakFrame): tasks.append(asyncio.create_task(synth(frame)))
    h.task.queue_frame = queue
    values = []
    try:
        for request in ('miss', 'hit'):
            start = time.monotonic()
            await h.gate.on_speak(SpeakRequest(request, 'policy', None, ['fixed greeting'], True))
            while not any(m['args'][0] == request for m in h.sent('playback_first_audio')):
                await asyncio.sleep(.001)
                if time.monotonic()-start > 2: raise TimeoutError('benchmark audio missing')
            values.append((time.monotonic()-start)*1000)
            while not any(m['args'][0] == request for m in h.sent('playback_stopped')):
                await asyncio.sleep(.001)
        assert len(tasks) == 1
        return values
    finally:
        await h.gate.close(); await asyncio.gather(*tasks, return_exceptions=True)
        await h.gate.cleanup(); await h.sink.cleanup()

async def main():
    pairs = [await pair() for _ in range(10)]
    serializer = HaloMediaSerializer(start_event={'event':'start', 'callId':'bench', 'parameters':{}})
    audio = pcm(1000); mulaw = pcm16_to_mulaw(audio)
    assert serializer._serialize_audio(audio) == serializer._serialize_audio(mulaw, 'mulaw')
    cpu = {}
    for name, data, codec in [('pcmConvert', audio, 'pcm16'), ('mulawPassthrough', mulaw, 'mulaw')]:
        values = []
        for _ in range(20):
            start = time.perf_counter(); serializer._serialize_audio(data, codec)
            values.append((time.perf_counter()-start)*1000)
        cpu[name] = summary(values)
    print(json.dumps({'evidence':'local test; injected 30ms synthesis; synthetic fixed policy; no provider calls', 'firstAudioMs':{'miss':summary([p[0] for p in pairs]), 'hit':summary([p[1] for p in pairs])}, 'oneSecondSerializationCpuMs':cpu, 'wireBytesIdentical':True}, indent=2))
if __name__ == '__main__': asyncio.run(main())
