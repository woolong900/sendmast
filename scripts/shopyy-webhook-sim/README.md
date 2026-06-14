# Shopyy webhook simulator

The simulator uses sanitized payloads from `fixtures/` by default. To test a
provider-specific payload locally, place it in the ignored `payloads/`
directory using the same event filename; local payloads take precedence.

Store the active webhook credentials in the ignored `.env.local` file:

```bash
STORE_ID=153667
KEY=<active store webhook secret>
TARGET_EMAIL=you@example.com
```

When `TARGET_EMAIL` is set, every email address in the generated payload is
replaced before the webhook is sent. This keeps all simulator events directed
to a controlled test inbox even when they use different payload files.

```bash
./fire.sh paid
./fire.sh create paid fulfilled
DRY_RUN=1 ./fire.sh paid
SM_MID=<shop-automation-send-id> ./fire.sh paid
```

Defaults target production. Explicit environment variables override
`.env.local` when testing another environment.
