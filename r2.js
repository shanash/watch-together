import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

export { PUBLIC_URL };

export async function listFiles(continuationToken) {
  const command = new ListObjectsV2Command({
    Bucket: BUCKET,
    MaxKeys: 200,
    ...(continuationToken && { ContinuationToken: continuationToken }),
  });
  const res = await s3.send(command);
  return {
    files: (res.Contents || []).map((f) => ({
      key: f.Key,
      size: f.Size,
      lastModified: f.LastModified,
    })),
    nextToken: res.IsTruncated ? res.NextContinuationToken : null,
  };
}

export async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function generatePresignedUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 1800 });
  const publicUrl = `${PUBLIC_URL}/${key}`;

  return { presignedUrl, publicUrl };
}
