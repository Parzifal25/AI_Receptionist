"""Runtime speech fallback for the Pipecat worker — HALO Phase B.

Reuses Pipecat's `ServiceSwitcher` rather than inventing a wrapper: the
primary and the fallback service sit side by side and exactly one is active.
The only thing added here is the decision of WHEN to switch.

A switch happens only for an error that is explicitly recoverable — the
provider was unreachable, timed out, rate-limited or failed server-side.
Everything else stays on the primary and surfaces: a rejected credential, an
unsupported language or an unclassified error is a misconfiguration or a bug,
and speaking through another provider would hide it.

The switch is one-way and lasts for the rest of the call (each call builds
its own pipeline, so the next call starts on the primary again). The
utterance or line that failed is not replayed into the fallback: a caller
utterance may already have been acted on, and a half-spoken line must not be
repeated.
"""

from __future__ import annotations
from correlation import CorrelationFilter

import asyncio
import logging
import re
import socket
from typing import Optional

from pipecat.frames.frames import ErrorFrame
from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyManual
from pipecat.processors.frame_processor import FrameProcessor

log = logging.getLogger("halo.worker.speech_fallback")
log.addFilter(CorrelationFilter())

_RECOVERABLE_STATUS = {408, 429}
_NETWORK_ERRORS = (ConnectionError, TimeoutError, asyncio.TimeoutError, socket.gaierror)
# Vendor errors that arrive as text only. The refusal list is checked first.
_NOT_RECOVERABLE_TEXT = re.compile(r"\b(401|403)\b|unauthori[sz]ed|forbidden|api[ _-]?key|invalid|unsupported|not supported", re.I)
_RECOVERABLE_TEXT = re.compile(
    r"\b(408|429|5\d\d)\b|connect|timed? ?out|unavailable|connection (closed|reset|lost)|rate.?limit|no audio data", re.I
)


def _status_code(exception: BaseException) -> Optional[int]:
    for holder in (exception, getattr(exception, "response", None)):
        status = getattr(holder, "status_code", None)
        if isinstance(status, int):
            return status
    return None


def is_recoverable(error: ErrorFrame) -> bool:
    """True only when the error is known to be a transient provider failure."""
    if error.fatal:
        return False
    exception = getattr(error, "exception", None)
    if exception is not None:
        recoverable = getattr(exception, "recoverable", None)
        if isinstance(recoverable, bool):
            return recoverable
        status = _status_code(exception)
        if status is not None:
            return status in _RECOVERABLE_STATUS or status >= 500
        if type(exception).__name__ in ("ConnectionClosed", "ConnectionClosedError", "ConnectionClosedOK"):
            return True
        if isinstance(exception, _NETWORK_ERRORS):
            return True
    text = str(error.error or "")
    if _NOT_RECOVERABLE_TEXT.search(text):
        return False
    return bool(_RECOVERABLE_TEXT.search(text))


class RecoverableFailover(ServiceSwitcherStrategyManual):
    """Advance to the next service on a recoverable error; never wrap around."""

    async def handle_error(self, error: ErrorFrame) -> Optional[FrameProcessor]:
        active = self._active_service
        if not is_recoverable(error):
            log.error("speech provider %s failed with a non-recoverable error; not falling back", active.name)
            return None
        index = self._services.index(active)
        if index + 1 >= len(self._services):
            log.error("speech provider %s failed and no fallback remains", active.name)
            return None
        fallback = self._services[index + 1]
        log.warning("speech fallback from=%s to=%s reason=recoverable_provider_failure", active.name, fallback.name)
        return await self._set_active_if_available(fallback)


def with_fallback(primary: FrameProcessor, fallback: FrameProcessor) -> ServiceSwitcher:
    return ServiceSwitcher(services=[primary, fallback], strategy_type=RecoverableFailover)
