export interface QueueFailedJobView {
  id: string;
  name: string;
  attemptsMade: number;
  attemptsLimit: number | null;
  failedReason: string | null;
  timestamp: string | null;
  processedOn: string | null;
  finishedOn: string | null;
  data: unknown;
}

export interface QueueOverview {
  name: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    paused: number;
    completed: number;
  };
  failedJobs: QueueFailedJobView[];
}
