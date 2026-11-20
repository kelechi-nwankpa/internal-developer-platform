/**
 * Log↔trace contract: every log line written inside an active span must
 * carry that span's trace_id + span_id. Grafana's Loki derivedFields
 * turn trace_id into the "View Trace" link to Tempo (ADR-0030), so a
 * regression here silently breaks the observability drill-down.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { context, trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

process.env['LOG_LEVEL'] = 'silent';
process.env['NODE_ENV'] = 'production';

const { traceMixin } = await import('../src/logger.js');

before(() => {
  // Without a registered context manager the OTel API is a no-op and no
  // span is ever "active" — the SDK registers one in production.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

test('outside any span, no trace fields are added', () => {
  assert.deepEqual(traceMixin(), {});
});

test('inside an active span, trace_id and span_id match that span', () => {
  const spanContext = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: TraceFlags.SAMPLED,
  };
  const span = trace.wrapSpanContext(spanContext);

  const fields = context.with(trace.setSpan(ROOT_CONTEXT, span), () => traceMixin());

  assert.deepEqual(fields, {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  });
});
