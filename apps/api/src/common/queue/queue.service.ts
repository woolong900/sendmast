import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { QUEUE_NAMES, type QueueName } from '@sendmast/shared';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();

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

  async onModuleDestroy(): Promise<void> {
    for (const q of this.queues.values()) await q.close();
    await this.connection.quit();
  }

  static get names() {
    return QUEUE_NAMES;
  }
}
