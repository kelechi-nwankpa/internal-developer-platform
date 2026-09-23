/**
 * pino JSON logger with trace_id injection.
 *
 * Every log line gets a `trace_id` and `span_id` from the active OTel
 * context (if any). This is what makes Grafana's Loki `derivedFields`
 * cross-link work — the regex `trace_id=(\w+)` in a log line becomes
 * a clickable "View Trace" button that jumps to Tempo.
 *
 * Format:
 *   - Production: single-line JSON (parsed by Alloy → Loki)
 *   - Local dev: pretty-printed (colored, human-readable) via pino-pretty
 *
 * See ADR-0030 for the observability triangle drill-down design.
 */

import { pino } from 'pino';
import { trace, context } from '@opentelemetry/api';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
  base: {
    service: process.env['OTEL_SERVICE_NAME'] ?? '{{SERVICE_NAME}}',
    environment: process.env['DEPLOYMENT_ENV'] ?? 'local',
  },
  // Inject trace_id + span_id from active OTel span on every log call.
  // Grafana's derivedFields regex matches `trace_id=<hex>` in log JSON.
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const spanCtx = span.spanContext();
    return {
      trace_id: spanCtx.traceId,
      span_id: spanCtx.spanId,
    };
  },
  // Pretty-print for local dev only. In containers, keep JSON so
  // Alloy → Loki can parse structured fields.
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }
    : undefined,
});
