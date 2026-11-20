/**
 * Route tests — exercised in-process via Fastify's inject() (no port).
 *
 * BUCKET_NAME is deliberately unset: these tests must run anywhere,
 * including CI, without MinIO/S3. The /hello happy path (real S3
 * round-trip) is covered by the in-cluster smoke test, not here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
delete process.env['BUCKET_NAME'];
process.env['LOG_LEVEL'] = 'silent';
process.env['NODE_ENV'] = 'production';

const { buildServer } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
});

test('GET /healthz returns ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET /readyz returns ready', async () => {
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ready' });
});

test('GET /metrics serves Prometheus text with default + custom metrics', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/plain/);
  assert.match(res.body, /nodejs_heap_size_total_bytes/);
  assert.match(res.body, /# TYPE http_requests_total counter/);
});

test('GET /hello without BUCKET_NAME fails loudly with 500, not a crash', async () => {
  const res = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().message, /BUCKET_NAME not set/);
});

test('unknown routes return a JSON 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().statusCode, 404);
});
