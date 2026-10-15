"""Deterministic worker context and wire identity contract; no sockets/providers."""
import asyncio
import copy
import logging
import unittest
from correlation import correlation_id, canonical_id, CorrelationFilter
from halo_client import SessionIdentity
from test_halo_client import READY, build

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'

class CorrelationTests(unittest.IsolatedAsyncioTestCase):
    async def test_wire_context_concurrent_and_cleanup(self):
        seen = []
        async def session(cid):
            ready = copy.deepcopy(READY)
            ready['session']['correlationId'] = cid
            client, _, _ = build([ready])
            async def on_ready(identity, voice):
                await asyncio.sleep(0)
                seen.append((identity.correlation_id, correlation_id.get()))
            client._handlers.on_ready = on_ready
            await client.run()
            self.assertIsNone(correlation_id.get())
        await asyncio.gather(session(A), session(B))
        self.assertCountEqual(seen, [(A,A),(B,B)])
        self.assertIsNone(correlation_id.get())

    async def test_malformed_wire_id_not_logged_and_identity_unchanged(self):
        payload = copy.deepcopy(READY['session'])
        payload['correlationId'] = 'synthetic-secret-token'
        identity = SessionIdentity.from_json(payload)
        self.assertEqual(identity.tenant_id, payload['tenantId'])
        self.assertNotIn('synthetic-secret-token', identity.correlation_id)
        self.assertEqual(canonical_id(A), A)
        self.assertNotEqual(canonical_id(None), canonical_id(None))

    async def test_error_log_keeps_only_safe_context(self):
        logger = logging.getLogger('ws4.synthetic')
        logger.addFilter(CorrelationFilter())
        token = correlation_id.set(A)
        try:
            with self.assertLogs(logger, level='ERROR') as captured:
                logger.error('session failed code=provider_failure')
            self.assertIn(A, captured.output[0])
            self.assertIn('provider_failure', captured.output[0])
        finally:
            correlation_id.reset(token)
