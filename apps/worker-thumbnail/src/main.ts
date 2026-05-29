import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser } from 'puppeteer-core';
import { QUEUE_NAMES } from '@sendmast/shared';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// Low concurrency: each Chromium tab is ~50-150MB and renders are infrequent
// (only on campaign content save), so we keep memory bounded on a single host.
const CONCURRENCY = Number(process.env.THUMBNAIL_CONCURRENCY ?? '2');
// Email clients converge on ~600px content width; render at that width then let
// the consumer (<img>) downscale to the 88px cell.
const RENDER_WIDTH = 600;
// Capture only the top of the email — a recognisable preview, not the whole
// (often very tall) body. Keeps the WebP small.
const MAX_HEIGHT = 900;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium';

const prisma = new PrismaClient();
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
});
const PUBLIC_BUCKET = process.env.S3_PUBLIC_BUCKET ?? 'sendmast-public';

function publicUrl(key: string): string {
  const base = (
    process.env.S3_PUBLIC_BASE_URL ??
    `${process.env.S3_ENDPOINT ?? ''}/${PUBLIC_BUCKET}`
  ).replace(/\/+$/, '');
  return `${base}/${key}`;
}

// ---------------------------------------------------------------------------
// Singleton browser — launched on first job, reused across jobs, relaunched if
// it crashes/disconnects. Cheaper than launching Chromium per render.
// ---------------------------------------------------------------------------
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--hide-scrollbars',
          '--mute-audio',
        ],
      })
      .then((b) => {
        b.on('disconnected', () => {
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function renderThumbnail(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: RENDER_WIDTH,
      height: 800,
      deviceScaleFactor: 1,
    });
    // Load the document and give remote images a chance to fetch. networkidle2
    // settles once ≤2 connections remain for 500ms; a slow/blocked tracking
    // pixel must not stall us, so we cap it and proceed regardless.
    try {
      await page.setContent(html, { waitUntil: 'networkidle2', timeout: 12000 });
    } catch {
      // timeout / nav error — render whatever has loaded so far.
    }
    // A short settle so late-arriving images paint before the snapshot.
    await new Promise((r) => setTimeout(r, 400));

    // Evaluated as a string so tsc doesn't need the DOM lib for this Node app.
    const contentHeight = Number(
      await page
        .evaluate('document.body ? document.body.scrollHeight : 0')
        .catch(() => 0),
    );
    const height = Math.min(Math.max(contentHeight || 0, 200), MAX_HEIGHT);

    const buf = (await page.screenshot({
      type: 'webp',
      quality: 72,
      clip: { x: 0, y: 0, width: RENDER_WIDTH, height },
      captureBeyondViewport: true,
    })) as Buffer;
    return buf;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runJob(job: Job<{ campaignId: string }>): Promise<void> {
  const { campaignId } = job.data;
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, accountId: true, html: true },
  });
  if (!campaign) return; // deleted before we got to it — nothing to do.

  if (!campaign.html || campaign.html.trim().length === 0) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { thumbnailPending: false },
    });
    return;
  }

  const buf = await renderThumbnail(campaign.html);

  const key = `images/${campaign.accountId}/thumb-${campaignId}-${randomUUID().slice(0, 8)}.webp`;
  await s3.send(
    new PutObjectCommand({
      Bucket: PUBLIC_BUCKET,
      Key: key,
      Body: buf,
      ContentType: 'image/webp',
    }),
  );

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { thumbnail: publicUrl(key), thumbnailPending: false },
  });
  console.log(`[thumbnail] rendered ${campaignId} (${buf.length} bytes)`);
}

const worker = new Worker<{ campaignId: string }>(
  QUEUE_NAMES.RENDER_THUMBNAIL,
  runJob,
  { connection, concurrency: CONCURRENCY },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  console.warn(`[thumbnail] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
  // On final failure stop the UI spinner — keep any existing thumbnail.
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.campaign
      .update({
        where: { id: job.data.campaignId },
        data: { thumbnailPending: false },
      })
      .catch(() => {});
  }
});

worker.on('ready', () => console.log('[thumbnail] worker ready'));

async function shutdown() {
  await worker.close();
  if (browserPromise) {
    await browserPromise.then((b) => b.close()).catch(() => {});
  }
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
