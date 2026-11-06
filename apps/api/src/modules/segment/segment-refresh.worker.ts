import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/queue/queue.service';

/** Daily cached-count refresh: off-peak, and executed by worker-sender. */
const REFRESH_JOB_ID = 'segment-refresh-daily';
const REFRESH_PATTERN = '17 4 * * *';
const REFRESH_TZ = 'Asia/Shanghai';

/**
 * Registers the daily segment-count refresh. The job itself runs in
 * worker-sender (COUNT-based, see @sendmast/audience refreshSegmentCounts):
 * it used to run inside the API process at 12:00 — peak hours — and
 * materialise every segment's full id set.
 */
@Injectable()
export class SegmentRefreshWorker implements OnModuleInit {
  private readonly logger = new Logger(SegmentRefreshWorker.name);

  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    const q = this.queue.getQueue(QueueService.names.SEGMENT_REFRESH);
    // Drop schedules from earlier versions (e.g. the old 12:00 run) so only
    // the current pattern fires.
    for (const r of await q.getRepeatableJobs()) {
      if (r.pattern !== REFRESH_PATTERN || r.tz !== REFRESH_TZ) {
        await q.removeRepeatableByKey(r.key);
      }
    }
    await this.queue.add(
      QueueService.names.SEGMENT_REFRESH,
      'daily',
      {},
      {
        jobId: REFRESH_JOB_ID,
        repeat: { pattern: REFRESH_PATTERN, tz: REFRESH_TZ },
        removeOnComplete: { age: 3600, count: 30 },
        removeOnFail: { age: 86400 * 7 },
      },
    );
    this.logger.log(
      `Segment refresh scheduled (${REFRESH_PATTERN} ${REFRESH_TZ}, runs in worker-sender)`,
    );
  }
}
