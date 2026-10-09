// Reads configuration from environment variables (.env is loaded by `node --env-file-if-exists`).
// AWS credentials are NOT read here: the AWS SDK finds them itself (AWS_PROFILE, ~/.aws, env).
export function loadConfig(env, { requireS3 = true } = {}) {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.AWS_REGION?.trim();
  if (requireS3 && !bucket) throw new Error('S3_BUCKET is required. Set it in .env (see .env.example).');
  if (requireS3 && !region) throw new Error('AWS_REGION is required. Set it in .env (see .env.example).');

  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}".`);
  }

  const maxUploadMb = Number(env.MAX_UPLOAD_MB?.trim() || 100);
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) {
    throw new Error(`MAX_UPLOAD_MB must be a positive number, got "${env.MAX_UPLOAD_MB}".`);
  }

  return {
    bucket,
    region,
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    maxUploadMb,
  };
}
