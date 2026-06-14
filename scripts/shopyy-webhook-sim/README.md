# Shopyy webhook simulator

The simulator uses sanitized payloads from `fixtures/` by default. To test a
provider-specific payload locally, place it in the ignored `payloads/`
directory using the same event filename; local payloads take precedence.

```bash
./fire.sh paid
./fire.sh create paid fulfilled
DRY_RUN=1 ./fire.sh paid
SM_MID=<shop-automation-send-id> ./fire.sh paid
```

Defaults target production. Set `BASE_URL` and matching `KEY` / `STORE_ID` when
testing another environment.
