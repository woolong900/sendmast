import { buildClickHouseClient } from './client.js';
import { DDL_STATEMENTS } from './ddl.js';

async function main() {
  const client = buildClickHouseClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    database: 'default',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  });

  for (const stmt of DDL_STATEMENTS) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`Applying: ${preview}...`);
    await client.command({ query: stmt });
  }

  await client.close();
  console.log(`Applied ${DDL_STATEMENTS.length} DDL statements.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
