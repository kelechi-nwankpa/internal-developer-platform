/**
 * Example endpoint — the "does the platform actually work?" smoke test.
 *
 * GET /hello  → writes a small object to the S3 bucket (via ObjectBucket
 *               XRC connection secret), reads it back, returns metadata.
 *
 * The trace waterfall shows: HTTP handler → S3 PutObject → S3 GetObject
 * → response. Every span carries the service name + trace_id. When
 * viewed in Grafana Tempo, this proves:
 *   - OTel auto-instrumentation captures the HTTP framework layer
 *   - AWS SDK instrumentation captures the S3 client calls
 *   - Structured logs (via pino mixin) include the same trace_id
 *
 * Environment (mounted via envFrom from ObjectBucket connection secret):
 *   BUCKET_NAME           — S3 bucket name (materialised from XRC)
 *   AWS_ACCESS_KEY_ID     — from MinIO on kind, IRSA on EKS
 *   AWS_SECRET_ACCESS_KEY — same
 *   AWS_ENDPOINT_URL      — MinIO service on kind; unset on EKS
 *   AWS_REGION            — required by AWS SDK
 */

import type { FastifyPluginAsync } from 'fastify';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { requestsTotal } from './health.js';

const bucketName = process.env['BUCKET_NAME'];
const s3Endpoint = process.env['AWS_ENDPOINT_URL'];  // MinIO on kind
const region = process.env['AWS_REGION'] ?? 'us-east-1';

const s3 = new S3Client({
  region,
  // If AWS_ENDPOINT_URL is set (MinIO on kind), use it. Otherwise the
  // SDK uses AWS's public S3 endpoint (EKS + IRSA).
  ...(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {}),
});

export const helloRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/hello', async (_request, reply) => {
    if (!bucketName) {
      requestsTotal.labels({ route: '/hello', status: '500' }).inc();
      return reply.internalServerError(
        'BUCKET_NAME not set — is the ObjectBucket XRC materialised?'
      );
    }

    const key = `hello-${Date.now()}.json`;
    const payload = {
      service: process.env['OTEL_SERVICE_NAME'] ?? '{{SERVICE_NAME}}',
      timestamp: new Date().toISOString(),
      message: 'Hello from the golden path template',
    };

    try {
      // Write — creates a span "S3 PutObject"
      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: JSON.stringify(payload),
        ContentType: 'application/json',
      }));

      // Read back — creates a span "S3 GetObject"
      const got = await s3.send(new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }));

      const body = await got.Body?.transformToString('utf-8');

      fastify.log.info({ bucket: bucketName, key }, 'hello roundtrip complete');
      requestsTotal.labels({ route: '/hello', status: '200' }).inc();

      return {
        bucket: bucketName,
        key,
        wrote: payload,
        readBack: body ? JSON.parse(body) : null,
      };
    } catch (err) {
      fastify.log.error({ err, bucket: bucketName, key }, 's3 roundtrip failed');
      requestsTotal.labels({ route: '/hello', status: '500' }).inc();
      return reply.internalServerError('S3 roundtrip failed — check logs');
    }
  });
};
