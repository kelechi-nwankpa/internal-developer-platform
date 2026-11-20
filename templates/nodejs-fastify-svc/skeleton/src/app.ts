/**
 * Server factory — builds the Fastify app WITHOUT listening.
 *
 * Kept separate from index.ts so tests can exercise routes in-process
 * via `app.inject()` (no port, no network). index.ts owns process
 * concerns: OTel bootstrap order, listen, and signal handling.
 */

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { logger } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { helloRoutes } from './routes/hello.js';

// Return type is inferred on purpose: passing our pino instance makes
// Fastify's logger generic `pino.Logger`, which the default
// `FastifyInstance` (FastifyBaseLogger) annotation would reject.
export async function buildServer() {
  const server = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    requestIdLogLabel: 'request_id',
    // Trust proxy headers from the edge proxy (Gateway API, ADR-0033) —
    // needed for correct client IP in logs once traffic arrives through it.
    trustProxy: true,
  });

  // Sensible: 404 → JSON error responses, httpErrors object for handlers
  await server.register(sensible);

  await server.register(healthRoutes);
  await server.register(helloRoutes);

  return server;
}
