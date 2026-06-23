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
When multiple local deploy targets exist, interactive `nstack deploy` asks which
environment to deploy. Automation should pass `--env <name>`.

This app may live inside a larger monorepo. Run nstack commands from the app
directory or pass `--cwd <app-dir>`; generated deploy files, client sync,
`.nstack` state, and source-backed Git dirty checks are scoped to that app. If
the app is in a Git subdirectory and `composePath`/`watchPaths` are not set,
nstack defaults Dokploy source settings to the app path, for example
`apps/web/deploy/nstack/compose.dokploy.yaml` and `["apps/web/**"]`.

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
Provider-backed source pushes can start newly declared Postgres, cache, and
object storage resources from generated Compose fallbacks. Run `nstack deploy`
to reconcile them with Dokploy-native resources.

## Frontend Design

Typography is a first-order design choice for Nuxt screens. Choose a designer
typeface that fits the app's subject, audience, and interface density instead
of defaulting to Inter, Geist, or the system stack. Fit matters more than
novelty; a good designer font can look plain, quiet, and practical. Consider
typefaces such as Excon, Satoshi, Newsreader, Hanken Grotesk, Bricolage
Grotesque, Absans, or another suitable family. Tune weights, line height,
spacing, and mobile rendering before treating the screen as done.

## Frontend API Client

The Nuxt app uses the generated Encore TypeScript client at
`frontend/app/generated/encore-client.ts`, wrapped by `apiClient()` in
`frontend/app/utils/api.ts` for the correct browser, SSR, and Dokploy base URLs.
The generated client's `Environment()` helper is patched for nstack/Dokploy
targets and does not point at Encore Cloud environments.

`nstack setup` or `pnpm setup` installs dependencies, bootstraps pnpm through
Corepack when needed, installs the Encore CLI with the official installer when
it is missing, and checks Docker only when declared Encore resources need it.
`pnpm dev` calls `nstack dev`, which runs the Encore backend, generated client
watcher, and Nuxt frontend. On a fresh clone, `pnpm dev` and `pnpm check` reuse
the CLI setup path before starting work. They stop with direct instructions when
Docker is not running or cannot be accessed. The watcher only rewrites the
client when the generated output changes, so Nuxt HMR is not triggered by
backend edits that leave the API surface unchanged. `pnpm check`, `pnpm build`,
and `nstack deploy` also sync it automatically. Use `nstack client gen` only
when you explicitly want to regenerate the client outside the normal workflow.
Generation and deploy metadata use local Encore commands for Dokploy/nstack
targets.
Client generation uses ignored temp files under `.nstack/tmp` and removes them
after each run. On startup, it prunes stale client temp files from interrupted
runs.

`backend/encore.app` intentionally leaves the Encore app id empty. That keeps
local `encore run` and `encore check` in Encore's local-only mode so they do not
fetch Encore Cloud secrets. Use `nstack.config.mjs` `app.slug` for app identity
in nstack and Dokploy; only fill the Encore id when intentionally linking this
repo to Encore Cloud.

When `nstack dev` detects an AI coding harness such as Codex, Claude Code, or a
custom `NSTACK_AGENT_HARNESS=<name>` value, it refuses to start a long-running
dev server by default. Agents should use `pnpm devexec '<js>'` from this app
directory for one-shot checks against a temporary dev stack. From a monorepo
root, use `pnpm --dir <app-dir> devexec '<js>'` or
`nstack devexec --cwd <app-dir> '<js>'`. Set `AI_ALLOW_DEVSERVER=1` only when
an agent truly needs an interactive dev server. For Paseo worktrees, run
`pnpm worktree`; it sets `AI_ALLOW_DEVSERVER=1` and uses `PASEO_PORT` to avoid
frontend collisions.
By default, `devexec` moves to the next free frontend or backend port when
`localhost:3000` or `localhost:4000` is already in use. If you pass an explicit
URL such as `--frontend-url`, that port must be free. Use
`screenshot("/", { width: 1440, height: 1000 })` inside devexec to capture pages;
screenshots default to `.nstack/screenshots`.

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
nstack logs
nstack logs --follow
nstack pull
nstack rollback
```

Failed deploys print a Dokploy log tail when one is available. Run `nstack logs [deployment-id] --tail 300` to read more from a specific deployment.
