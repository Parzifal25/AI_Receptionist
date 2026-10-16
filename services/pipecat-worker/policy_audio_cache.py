"""Bounded call-local fixed-policy audio. No user/model text or shared cache."""
from collections import OrderedDict

class PolicyAudioCache:
    def __init__(self, max_entries=4, max_bytes=512000):
        self._rows = OrderedDict()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._bytes = 0

    def get(self, key):
        value = self._rows.get(key)
        if value is not None:
            self._rows.move_to_end(key)
        return value

    def put(self, key, frames):
        size = sum(len(frame[0]) for frame in frames)
        if not frames or size > min(128000, self._max_bytes) or len(frames) > 256:
            return
        previous = self._rows.pop(key, ())
        self._bytes -= sum(len(frame[0]) for frame in previous)
        self._rows[key] = tuple(frames)
        self._bytes += size
        while len(self._rows) > self._max_entries or self._bytes > self._max_bytes:
            _, dropped = self._rows.popitem(last=False)
            self._bytes -= sum(len(frame[0]) for frame in dropped)

    def clear(self):
        self._rows.clear()
        self._bytes = 0
