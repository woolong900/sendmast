import 'dotenv/config';
import { Worker, DelayedError, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient, Prisma } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { QUEUE_NAMES } from '@sendmast/shared';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const BATCH_SIZE = 1000;

// Worker total concurrency. Increase via env if you need to push more import
// jobs in parallel — but per-tenant cap below still applies, so a single
// noisy tenant cannot starve everyone else.
const WORKER_CONCURRENCY = Number(process.env.IMPORT_CONCURRENCY ?? '8');
// Each tenant (accountId) is allowed at most this many in-flight import jobs.
// Extra jobs from the same tenant are pushed back as delayed for a few
// seconds so other tenants get a worker slot.
const MAX_INFLIGHT_PER_ACCOUNT = Number(process.env.IMPORT_PER_ACCOUNT ?? '2');
// Defensive TTL on the semaphore counter — if a worker dies without running
// `finally`, the counter reclaims itself after this many ms instead of
// locking the tenant out forever.
const INFLIGHT_TTL_MS = 60 * 60 * 1000;

const prisma = new PrismaClient();
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Per-account semaphore: atomic INCR + boundary check via Lua.
// Returns 0 when the tenant is already at the cap (caller must back off).
// ---------------------------------------------------------------------------
const TRY_ACQUIRE_LUA = `
local c = redis.call('INCR', KEYS[1])
if c > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return c
`;

connection.defineCommand('importTryAcquire', {
  numberOfKeys: 1,
  lua: TRY_ACQUIRE_LUA,
});

interface ConnWithImportCmd extends IORedis {
  importTryAcquire(key: string, max: string, ttlMs: string): Promise<number>;
}

function inflightKey(accountId: string): string {
  return `import:inflight:${accountId}`;
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
});
const BUCKET = process.env.S3_BUCKET ?? 'sendmast-uploads';

interface JobData {
  jobId: string;
  overwriteExisting?: boolean;
}

interface ContactRow {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  gender?: string;
  country?: string;
  state?: string;
  city?: string;
  zip?: string;
  language?: string;
}

const COL_MAP: Record<string, keyof ContactRow> = {
  email: 'email',
  'e-mail': 'email',
  first_name: 'firstName',
  firstname: 'firstName',
  'first name': 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  'last name': 'lastName',
  phone: 'phone',
  mobile: 'phone',
  gender: 'gender',
  country: 'country',
  state: 'state',
  province: 'state',
  city: 'city',
  zip: 'zip',
  postcode: 'zip',
  language: 'language',
  lang: 'language',
};

function normaliseRow(record: Record<string, string>): ContactRow | null {
  const out: Partial<ContactRow> = {};
  for (const [k, v] of Object.entries(record)) {
    const target = COL_MAP[k.toLowerCase().trim()];
    if (target && v) (out as Record<string, string>)[target] = v.trim();
  }
  if (!out.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return null;
  out.email = out.email.toLowerCase();
  return out as ContactRow;
}

async function runJob(job: Job<JobData>, token?: string) {
  const dbJob = await prisma.importJob.findUnique({ where: { id: job.data.jobId } });
  if (!dbJob) throw new Error(`ImportJob ${job.data.jobId} not found`);

  // Tenant fairness: never let one accountId hog all worker slots.
  const acquired = await (connection as ConnWithImportCmd).importTryAcquire(
    inflightKey(dbJob.accountId),
    String(MAX_INFLIGHT_PER_ACCOUNT),
    String(INFLIGHT_TTL_MS),
  );
  if (acquired === 0) {
    await job.moveToDelayed(Date.now() + 5000, token);
    throw new DelayedError();
  }

  try {
    await runJobBody(job, dbJob);
  } finally {
    await connection.decr(inflightKey(dbJob.accountId));
  }
}

async function runJobBody(
  job: Job<JobData>,
  dbJob: NonNullable<Awaited<ReturnType<typeof prisma.importJob.findUnique>>>,
) {
  const overwriteExisting = job.data.overwriteExisting ?? false;

  await prisma.importJob.update({
    where: { id: dbJob.id },
    data: { status: 'processing', startedAt: new Date() },
  });

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: dbJob.storageKey }));
  const stream = obj.Body as Readable;

  const parser = stream.pipe(
    parse({
      columns: (h: string[]) => h.map((c) => c.toLowerCase().trim()),
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }),
  );

  let batch: ContactRow[] = [];
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let seen = 0;
  let lastProgressAt = 0;

  const writeProgress = async (force = false) => {
    if (!force && Date.now() - lastProgressAt < 500) return;
    lastProgressAt = Date.now();
    await prisma.importJob.update({
      where: { id: dbJob.id },
      data: {
        processedRows: seen,
        insertedRows: inserted,
        updatedRows: updated,
        skippedRows: skipped,
      },
    });
  };

  const flush = async () => {
    if (batch.length === 0) return;
    const result = await upsertBatch(dbJob.accountId, dbJob.listId, batch, overwriteExisting);
    inserted += result.inserted;
    updated += result.updated;
    skipped += result.skipped;
    processed += batch.length;
    batch = [];
    await writeProgress(true);
  };

  try {
    for await (const record of parser) {
      seen += 1;
      const row = normaliseRow(record);
      if (!row) {
        skipped += 1;
        await writeProgress();
        continue;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
      else await writeProgress();
    }
    await flush();

    await prisma.importJob.update({
      where: { id: dbJob.id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        // We are the source of truth for totalRows — the API no longer
        // pre-counts (avoids blocking the event loop on big CSVs).
        totalRows: processed + skipped,
        processedRows: processed,
        insertedRows: inserted,
        updatedRows: updated,
        skippedRows: skipped,
      },
    });
    console.log(
      `[import ${dbJob.id}] done: processed=${processed} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: dbJob.id },
      data: { status: 'failed', errorMessage: msg, finishedAt: new Date() },
    });
    throw err;
  }
}

async function upsertBatch(
  accountId: string,
  listId: string | null,
  rows: ContactRow[],
  overwriteExisting: boolean,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  // Deduplicate by email within the batch (last wins)
  const map = new Map<string, ContactRow>();
  for (const r of rows) map.set(r.email, r);
  const dedup = Array.from(map.values());
  const inBatchSkipped = rows.length - dedup.length;

  const emails = dedup.map((r) => r.email);
  const existing = await prisma.contact.findMany({
    where: { accountId, email: { in: emails } },
    select: { id: true, email: true },
  });
  const existingMap = new Map(existing.map((e) => [e.email, e.id]));

  const toCreate = dedup.filter((r) => !existingMap.has(r.email));
  const toUpdate = dedup.filter((r) => existingMap.has(r.email));

  if (toCreate.length > 0) {
    await prisma.contact.createMany({
      data: toCreate.map((r) => ({ accountId, ...r })),
      skipDuplicates: true,
    });
  }

  let updated = 0;
  let existingSkipped = 0;
  if (overwriteExisting && toUpdate.length > 0) {
    // One round-trip for the whole batch:
    //   INSERT ... VALUES (...), (...) ON CONFLICT (account_id, email) DO UPDATE SET ...
    // Every email in toUpdate is known to exist (we just SELECTed them above),
    // so the INSERT row is never actually written — we only use it to drive
    // the DO UPDATE branch. id/created_at therefore can be any placeholder.
    const values = toUpdate.map(
      (r) => Prisma.sql`(
        ${randomUUID()}::uuid,
        ${accountId}::uuid,
        ${r.email},
        ${r.firstName ?? null},
        ${r.lastName ?? null},
        ${r.phone ?? null},
        ${r.gender ?? null},
        ${r.country ?? null},
        ${r.state ?? null},
        ${r.city ?? null},
        ${r.zip ?? null},
        ${r.language ?? null},
        NOW(),
        NOW()
      )`,
    );
    await prisma.$executeRaw`
      INSERT INTO contacts (
        id, account_id, email,
        first_name, last_name, phone, gender,
        country, state, city, zip,
        language, created_at, updated_at
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT (account_id, email) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        phone      = EXCLUDED.phone,
        gender     = EXCLUDED.gender,
        country    = EXCLUDED.country,
        state      = EXCLUDED.state,
        city       = EXCLUDED.city,
        zip        = EXCLUDED.zip,
        language   = EXCLUDED.language,
        updated_at = NOW()
    `;
    updated = toUpdate.length;
  } else {
    // Default: keep the existing contact untouched but still link them to the list
    existingSkipped = toUpdate.length;
  }

  if (listId) {
    const allRows = await prisma.contact.findMany({
      where: { accountId, email: { in: emails } },
      select: { id: true },
    });
    await prisma.contactListMembership.createMany({
      data: allRows.map((r) => ({ listId, contactId: r.id })),
      skipDuplicates: true,
    });
  }

  return {
    inserted: toCreate.length,
    updated,
    skipped: inBatchSkipped + existingSkipped,
  };
}

const worker = new Worker<JobData>(QUEUE_NAMES.IMPORT_CONTACTS, runJob, {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

worker.on('failed', (job, err) =>
  console.error(`[import ${job?.id}] failed: ${err.message}`, err.stack),
);
worker.on('completed', (job) => console.log(`[import ${job.id}] completed`));

console.log('worker-import started');

async function shutdown() {
  console.log('Shutting down worker-import...');
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
