/**
 * OpenTelemetry SDK bootstrap. THIS MODULE MUST BE IMPORTED FIRST —
 * before any framework or third-party module — so auto-instrumentation
 * monkey-patches those modules at their initial import time.
 *
 * Environment variables (standard OTel — inherited from process env):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   — Collector endpoint (e.g. http://otel-collector:4318)
 *   OTEL_SERVICE_NAME             — this service's identifier in traces
 *   OTEL_RESOURCE_ATTRIBUTES      — extra span attributes (e.g. deployment.environment=prod)
 *
 * Traces are exported via OTLP HTTP. If OTEL_EXPORTER_OTLP_ENDPOINT is unset,
 * SDK falls back to http://localhost:4318 — fine for local dev via port-forward.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';

const serviceName = process.env['OTEL_SERVICE_NAME'] ?? '{{SERVICE_NAME}}';

const sdk = new NodeSDK({
  // @opentelemetry/resources 1.28.0 does not export `resourceFromAttributes`
  // (added in later 2.x). Use `new Resource({...})` with the literal
  // `service.name` key from the OTel spec — avoids semantic-conventions
  // import churn between minor versions. Found during Phase 6 Task 6.4c
  // building platform-hello (bug 2 of Phase 6).
  resource: new Resource({
    'service.name': serviceName,
  }),
  traceExporter: new OTLPTraceExporter({
    // No `url` — SDK reads OTEL_EXPORTER_OTLP_ENDPOINT from env
    // and appends `/v1/traces`. Falls back to http://localhost:4318.
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable the fs instrumentation — extremely noisy (every file
      // read becomes a span). Turn on selectively when debugging.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Graceful shutdown — flush pending spans to the Collector.
// SIGTERM handler in src/index.ts calls this via sdk.shutdown().
process.on('SIGTERM', () => {
  sdk.shutdown()
    .catch((err) => {
      // Can't use logger here — logger imports observability, would circular
      // eslint-disable-next-line no-console
      console.error('OTel SDK shutdown failed', err);
    });
});

export { sdk };
