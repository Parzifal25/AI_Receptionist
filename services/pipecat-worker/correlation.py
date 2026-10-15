"""Safe session logging context. No identity, payload, credentials or exporter."""
import contextvars
import logging
import re
import uuid

correlation_id = contextvars.ContextVar("halo_correlation_id", default=None)

def canonical_id(value):
    if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value):
        return value
    return str(uuid.uuid4())

class CorrelationFilter(logging.Filter):
    def filter(self, record):
        record.correlationId = correlation_id.get()
        # Existing formatters need not know about the extra field.
        if record.correlationId:
            record.msg = "[correlation=%s] " + str(record.msg)
            record.args = (record.correlationId,) + tuple(record.args or ())
        return True
