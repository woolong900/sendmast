# Local infra (docker-compose)

Run from repo root:

```bash
pnpm infra:up
```

Services exposed:

| Service     | Port(s)              | Notes                                |
| ----------- | -------------------- | ------------------------------------ |
| PostgreSQL  | 5432                 | user/pass: `sendwalk` / `sendwalk`   |
| Redis       | 6379                 | no password                          |
| ClickHouse  | 8123 (HTTP)          | user `default`, no password          |
| MinIO API   | 9000                 | `sendwalk` / `sendwalk-secret`       |
| MinIO Console | 9001               | open in browser                      |
| Mailhog SMTP | 1025                | dev mail relay                       |
| Mailhog UI  | 8025                 | open in browser                      |

Persistent volumes are written under `docker/data/` (gitignored).

To wipe everything: `pnpm infra:down && rm -rf docker/data`.
