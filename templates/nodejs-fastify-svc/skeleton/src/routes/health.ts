/**
 * Kubernetes probes + Prometheus /metrics.
 *
 * /healthz — liveness. 200 = process alive; kubelet uses this to decide
 *            whether to restart the pod.
 * /readyz  — readiness. 200 = ready to serve traffic; kubelet uses this
 *            to decide whether to route Service traffic here. Distinct
 *            from liveness because a pod may be alive (don't restart)
 *            but not ready (don't send traffic — e.g. during startup).
 * /metrics — Prometheus scrape endpoint. Default Node.js process metrics
 *            (heap, event loop lag, GC, active handles) + custom app
 *            counters. Scraped by the ServiceMonitor in
 *            kubernetes/servicemonitor.yaml.
 */

import type { FastifyPluginAsync } from 'fastify';
import { register, collectDefaultMetrics, Counter } from 'prom-client';

// Enable default Node.js process metrics (heap, event loop, GC).
// Prefixed with `nodejs_` for easy filtering in Prometheus.
collectDefaultMetrics();

// Example custom counter — increment from your business-logic routes.
export const requestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by route + status',
  labelNames: ['route', 'status'] as const,
});

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness — cheap check, no external dependencies.
  fastify.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Readiness — verify anything we depend on. For MVP: same as liveness.
  // Real services would check DB connectivity, S3 reachability, cache
  // warm-up state, etc. Keep it fast (< 500ms) — Kubernetes probes this
  // every few seconds.
  fastify.get('/readyz', async () => {
    // TODO(prod): add real dependency checks here.
    return { status: 'ready' };
  });

  // Prometheus /metrics endpoint.
  // Content-Type must be exactly text/plain per Prometheus format spec.
  fastify.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });
};
