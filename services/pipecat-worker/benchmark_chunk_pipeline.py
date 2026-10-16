"""Synthetic W4.3 benchmark of the actual MediaGate, never provider evidence.
Run: .venv/bin/python services/pipecat-worker/benchmark_chunk_pipeline.py
"""
import asyncio
import json
import statistics
import time
from test_media_gate import MediaGateTests, pcm, RATE
from halo_client import SpeakRequest
from pipecat.frames.frames import TTSSpeakFrame, TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

async def sample(pipeline):
    h = MediaGateTests()
    await h.asyncSetUp()
    tasks = []
    first_audio = []
    end_play = []
    tail = 0.0
    async def synth(frame):
        await asyncio.sleep(.03)
        ctx = str(id(frame))
        await h.gate.process_frame(TTSStartedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
        first_audio.append(time.monotonic())
        await h.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id=ctx), FrameDirection.DOWNSTREAM)
        await h.gate.process_frame(TTSStoppedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
    async def queue(frame):
        h.task.frames.append(frame)
        if isinstance(frame, TTSSpeakFrame): tasks.append(asyncio.create_task(synth(frame)))
    h.task.queue_frame = queue
    def start_mark(playback_id, index):
        nonlocal tail
        tail = max(tail, time.monotonic()) + .1
        deadline = tail
        async def wait():
            await asyncio.sleep(max(0, deadline - time.monotonic()))
            end_play.append(time.monotonic())
            return True
        return wait()
    async def serial_wait(playback_id, index):
        return await start_mark(playback_id, index)
    if pipeline and hasattr(h.gate, 'set_playout_starter'):
        h.gate.set_playout_starter(start_mark)
    else:
        h.gate.set_playout_waiter(serial_wait)
    start = time.monotonic()
    try:
        await h.gate.on_speak(SpeakRequest(playback_id='bench', kind='reply', turn_id='t', chunks=['first.', 'second.'], interruptible=True))
        async def complete():
            while not h.sent('playback_stopped'):
                await asyncio.sleep(.001)
        await asyncio.wait_for(complete(), 3)
        return {'totalMs': (time.monotonic()-start)*1000, 'gapMs': max(0, first_audio[1]-end_play[0])*1000}
    finally:
        await h.gate.close()
        await asyncio.gather(*tasks, return_exceptions=True)
        await h.gate.cleanup()
        await h.sink.cleanup()

def stats(values):
    return {'n': len(values), 'p50': round(statistics.median(values), 3), 'p95': round(sorted(values)[int(.95*len(values))-1], 3), 'max': round(max(values), 3)}
async def main():
    result = {'evidence': 'local test; injected delays; no provider calls', 'synthesisMs': 30, 'playoutMs': 100, 'chunks': 2}
    for mode in [False, True]:
        samples = [await sample(mode) for _ in range(10)]
        result['pipelined' if mode else 'serial'] = {k: stats([s[k] for s in samples]) for k in samples[0]}
    print(json.dumps(result, indent=2))
if __name__ == '__main__': asyncio.run(main())
