import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  public readonly client: S3Client;
  public readonly bucket: string;
  public readonly publicBucket: string;
  private readonly endpoint: string;
  private readonly publicBaseUrl: string;
  private readonly webBaseUrl: string;

  constructor(config: ConfigService) {
    this.endpoint = config.getOrThrow<string>('S3_ENDPOINT');
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: config.get('S3_REGION') ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.getOrThrow('S3_ACCESS_KEY'),
        secretAccessKey: config.getOrThrow('S3_SECRET_KEY'),
      },
    });
    this.bucket = config.get('S3_BUCKET') ?? 'sendmast-uploads';
    this.publicBucket = config.get('S3_PUBLIC_BUCKET') ?? 'sendmast-public';
    this.publicBaseUrl =
      config.get<string>('S3_PUBLIC_BASE_URL') ?? `${this.endpoint}/${this.publicBucket}`;
    this.webBaseUrl =
      config.get<string>('WEB_BASE_URL') ?? config.getOrThrow<string>('API_BASE_URL');
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket ${this.bucket}`);
    }
  }

  async putObject(key: string, body: Buffer | Readable, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Upload an object into the anonymous-readable public bucket. Used for
   * email-content assets (images embedded in templates / campaigns) which
   * recipients must be able to load without authentication.
   */
  async putPublicObject(
    key: string,
    body: Buffer | Readable,
    contentType?: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.publicBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return this.getPublicUrl(key);
  }

  /**
   * Build an absolute, externally-reachable URL for an object in the public
   * bucket. Email clients do not have a page origin, so origin-relative image
   * paths become broken after delivery.
   */
  getPublicUrl(key: string): string {
    const base = this.absolutePublicBaseUrl().replace(/\/+$/, '');
    return `${base}/${key.replace(/^\/+/, '')}`;
  }

  private absolutePublicBaseUrl(): string {
    if (!this.publicBaseUrl.startsWith('/')) return this.publicBaseUrl;
    const origin = this.webBaseUrl.replace(/\/+$/, '');
    return `${origin}${this.publicBaseUrl}`;
  }

  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return response.Body as Readable;
  }

  async presignPut(key: string, expiresInSec = 600): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSec });
  }
}
