import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildClickHouseClient } from '@sendmast/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';

@Injectable()
export class ClickHouseService implements OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
  public readonly client: ClickHouseClient;

  constructor(config: ConfigService) {
    this.client = buildClickHouseClient({
      url: config.getOrThrow('CLICKHOUSE_URL'),
      database: config.get('CLICKHOUSE_DATABASE') ?? 'sendmast',
      username: config.get('CLICKHOUSE_USER') ?? 'default',
      password: config.get('CLICKHOUSE_PASSWORD') ?? '',
    });
    this.logger.log('ClickHouse client initialised');
  }

  async query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const result = await this.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return result.json<T>();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
