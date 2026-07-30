import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { QUEUE_NAMES, type QueueName, type QueueOverview } from '@sendmast/shared';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(config: ConfigService) {
    this.connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
  }

  getQueue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400 * 7 },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T>(name: QueueName, jobName: string, data: T, opts?: JobsOptions) {
    return this.getQueue(name).add(jobName, data, opts);
  }

  async overview(): Promise<QueueOverview[]> {
    const names = Object.values(QUEUE_NAMES);
    const rows: QueueOverview[] = [];
    for (const name of names) {
      const q = this.getQueue(name);
      const counts = await q.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'paused',
        'completed',
      );
      const failedJobs = await q.getFailed(0, 9);
      rows.push({
        name,
        counts: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          paused: counts.paused ?? 0,
          completed: counts.completed ?? 0,
        },
        failedJobs: failedJobs.map((job) => ({
          id: String(job.id ?? ''),
          name: job.name,
          attemptsMade: job.attemptsMade,
          attemptsLimit: typeof job.opts.attempts === 'number' ? job.opts.attempts : null,
          failedReason: job.failedReason ?? null,
          timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
          processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          data: job.data,
        })),
      });
    }
    return rows;
  }

  createWorker<T>(
    key: string,
    name: QueueName,
    processor: Processor<T>,
    opts?: Omit<WorkerOptions, 'connection'>,
  ): Worker<T> {
    const existing = this.workers.get(key);
    if (existing) return existing as Worker<T>;
    const worker = new Worker<T>(name, processor, {
      connection: this.connection,
      ...opts,
    });
    worker.on('failed', (job, err) => {
      this.logger.error(
        `Queue ${name} job ${job?.id ?? 'unknown'} failed: ${err.message}`,
        err.stack,
      );
    });
    this.workers.set(key, worker);
    return worker;
  }

  async onModuleDestroy(): Promise<void> {
    for (const worker of this.workers.values()) await worker.close();
    for (const q of this.queues.values()) await q.close();
    await this.connection.quit();
  }

  static get names() {
    return QUEUE_NAMES;
  }
}
