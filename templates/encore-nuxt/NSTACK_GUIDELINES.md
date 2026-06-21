# nstack Guidelines

## Stack

This app is generated for nstack and deploys to Dokploy.

- Backend: Encore.ts in `backend/`
- Frontend: Nuxt in `frontend/`
- Package manager: pnpm workspace
- Deploy target: Dokploy Compose managed by `nstack`

## Deployment Model

`nstack deploy` inspects Encore metadata, renders `deploy/nstack/`, syncs Dokploy
resources, pushes source when source-backed deploys are configured, updates the
Dokploy Compose app, syncs schedules/domains, and verifies the deployment.

Do not edit `deploy/nstack/encore.infra.json` or
`deploy/nstack/compose.dokploy.yaml` directly. Change app code or
`nstack.config.mjs`, then run `nstack deploy`.

## Resources

Declare durable resources in Encore code:

- SQL databases with `SQLDatabase`
- Caches with Encore cache resources
- Object buckets with `Bucket`
- Cron jobs with Encore cron metadata
- Pub/Sub topics with Encore topic resources

When a declared resource is removed, `nstack deploy` may ask before deleting the
matching Dokploy resource. If cleanup is declined, the ignore is recorded in
`nstack.config.mjs`.

For source-backed/git deploys, destructive resource cleanup is skipped.

## Backups

Use `nstack backup` before risky infrastructure changes. Backups are written to
`.nstack/backups/<target>/<year-month-day-hour-minute-second-utc>/` and include
Dokploy/app snapshots, remote Dokploy Compose env values in `compose.env`, and
local data artifacts for stateful resources:
Postgres dumps and volume tars for Redis-compatible cache, RustFS object storage,
and NSQ Pub/Sub data. Snapshot files preserve secrets for recovery, so keep
`.nstack/backups` private.

Destructive deletion paths create a critical local backup first and stop if the
backup cannot be completed. To explicitly delete without that guard, run the CLI
with `NSTACK_NO_BACKUPS_ON_DELETION=1`. Data backups use Dokploy API-backed
backup jobs and require a Dokploy backup destination; use
`--backup-destination-id <id>` or `NSTACK_BACKUP_DESTINATION_ID` when needed. If
none exists, nstack aborts before destructive deletion.

## Secrets

Runtime secrets belong in `.nstack/secrets.env` or Dokploy env, never in source.

Use:

```sh
nstack env set SECRET_NAME
nstack env push
nstack env pull --all
```

Deploy target settings live in `.nstack/local.env`.

## Checks And Recovery

Before deploy:

```sh
pnpm check
```

For deployment issues:

```sh
nstack doctor
nstack status
nstack logs --follow
nstack pull
nstack rollback
```
