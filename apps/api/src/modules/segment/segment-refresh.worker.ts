import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { QueueService } from '../../common/queue/queue.service';
import { SegmentService } from './segment.service';

@Injectable()
export class SegmentRefreshWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SegmentRefreshWorker.name);
  private readonly connection: Redis;
  private worker: Worker | null = null;

  constructor(
    config: ConfigService,
    private readonly queue: QueueService,
    private readonly segments: SegmentService,
  ) {
    this.connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      QueueService.names.SEGMENT_REFRESH,
      'daily',
      {},
      {
        jobId: 'segment-refresh-daily',
        repeat: { pattern: '0 12 * * *', tz: 'Asia/Shanghai' },
        removeOnComplete: { age: 3600, count: 30 },
        removeOnFail: { age: 86400 * 7 },
      },
    );

    this.worker = new Worker(
      QueueService.names.SEGMENT_REFRESH,
      async () => {
        const result = await this.segments.refreshAllSegments();
        this.logger.log(
          `daily refresh complete: ${result.refreshed}/${result.total} refreshed, ${result.failed} failed`,
        );
        return result;
      },
      { connection: this.connection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `daily refresh job ${job?.id ?? '(unknown)'} failed: ${err.message}`,
        err.stack,
      );
    });

    this.logger.log('Segment refresh scheduler registered (daily 12:00 Asia/Shanghai)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection.quit();
  }
}
