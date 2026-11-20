// OTel bootstrap MUST be the first import — auto-instrumentation only
// works if OTel wraps modules at their initial import time.
import './observability.js';

import { logger } from './logger.js';
import { buildServer } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '0.0.0.0';

const server = await buildServer();

// Bootstrap
try {
  await server.listen({ port, host });
  logger.info({ port, host }, 'server started');
} catch (err) {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
}

// Graceful shutdown — Kubernetes sends SIGTERM on pod termination.
// 15s should be enough to drain in-flight requests + flush OTel spans.
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutdown initiated');
  try {
    await server.close();
    logger.info('server closed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'graceful shutdown failed');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
