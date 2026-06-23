# nstack

`nstack` is a small release layer for Encore + Nuxt apps on Dokploy.

It keeps the app shape boring:

```sh
curl -fsSL https://nstack.tech/install.sh | bash
nstack init my-app
cd my-app
nstack setup
nstack deploy
```

Interactive `nstack init` can link Dokploy by picking a saved Dokploy instance
or adding a new one, then asks you to pick an existing Git provider or add a
manual Git source. It also asks which package manager to use for init; the
Encore + Nuxt template currently supports pnpm and can remember it as the
default for new projects. In CI, use `nstack configure` with flags or env vars
for the same settings.

`nstack init` initializes a git repository when needed, creates the initial
`init` commit, and sets `origin` when a repository URL is configured. If the app
is created inside an existing worktree, nstack does not create a nested repo; it
commits only the new app directory into the parent worktree. Before that commit,
it runs `pnpm install` and `pnpm approve-builds --all`, so the lockfile and pnpm
build approvals are part of the first commit. Source-backed deploys push the
current repo before asking Dokploy to build it. When the backing Git repository
needs to be created first, nstack treats a private repository as the default.

`nstack deploy` discovers Encore resources, renders Encore infra and Dokploy
Compose, lets Dokploy build the production backend/frontend services from source,
provisions Dokploy resources, creates Dokploy Domains/Traefik routes, deploys,
verifies the public URL, and prints the result.

For automatic deploy-on-push, connect the matching Git provider in Dokploy first.
nstack can configure Dokploy Compose source deployments for GitHub, GitLab,
Bitbucket, and Gitea/Forgejo when Dokploy has that provider connected. Plain Git
source mode is available for custom hosts, but provider-backed sources are the
path that gives Dokploy native push webhooks.

## Daily Commands

```sh
nstack setup    # install local tooling and dependencies
pnpm dev        # or: nstack dev
nstack devexec 'await apiJson("/status")'
pnpm check      # or: nstack check
nstack deploy
nstack status
```

Use `nstack env set NAME` for runtime secrets and `nstack logs --follow` when a
deploy is running. `nstack update` refreshes a git-installed nstack checkout.
The CLI prints an update notice after normal commands when nstack.tech reports a
newer version.

## When Needed

```sh
nstack doctor
nstack target create staging --domain staging.example.com
nstack pull
nstack update
nstack backup
nstack rollback
nstack undeploy --yes
nstack cleanup
nstack open dashboard
```

The generated app keeps package scripts as aliases to the CLI. `nstack setup`
installs project dependencies, bootstraps pnpm through Corepack when needed,
installs the Encore CLI with the official installer when it is missing, and
checks Docker only when declared Encore resources need it. `pnpm dev` calls
`nstack dev` to run the Encore backend, Nuxt frontend, and generated client sync
for HMR. On a fresh clone, `pnpm dev` and `pnpm check` reuse the CLI setup path
before running. They stop with direct instructions when Docker is not running or
cannot be accessed. `pnpm check`, `pnpm build`, and `nstack deploy` sync the
Encore TypeScript client used by the Nuxt frontend. `nstack client gen` is
available when you explicitly want to regenerate it. Client generation and
deploy metadata use local Encore commands for Dokploy/nstack targets.

Generated templates intentionally keep `backend/encore.app` with an empty
Encore app id. That is Encore's local-only mode and prevents local
`encore run` or `encore check` from fetching Encore Cloud secrets. nstack uses
`nstack.config.mjs` `app.slug` as the Dokploy/nstack identity instead.

When `nstack dev` detects an AI coding harness such as Codex or Claude Code, it
refuses to start a long-running dev server by default. Agents should use
`nstack devexec '<js>'` for one-shot checks against a temporary dev stack. Set
`NSTACK_AGENT_HARNESS=<name>` for custom harnesses, or `AI_ALLOW_DEVSERVER=1`
when an agent truly needs an interactive dev server.

`nstack cleanup` uses Dokploy cleanup endpoints for stopped containers, unused
images, unused volumes, and Docker builder cache.

`nstack backup` writes local snapshots under
`.nstack/backups/<target>/<year-month-day-hour-minute-second-utc>/`. It stores
Dokploy/app metadata, remote Dokploy Compose env values in `compose.env`, and
data artifacts for stateful resources:
Postgres dumps and Dokploy volume tars for Redis-compatible cache, RustFS object
storage, and NSQ Pub/Sub data. Snapshot files preserve secrets for recovery, so
keep `.nstack/backups` private.

Destructive deletion paths create a critical local backup first and refuse to
continue if the backup cannot be completed. To intentionally delete without that
guard, start the CLI with `NSTACK_NO_BACKUPS_ON_DELETION=1`. Data backups use
Dokploy API-backed backup jobs and require a Dokploy backup destination; pass
`--backup-destination-id <id>` or set `NSTACK_BACKUP_DESTINATION_ID` when more
than one destination exists. If none exists, nstack aborts before destructive
deletion.

For the detailed operator guide, see [USING_NSTACK.md](USING_NSTACK.md).

## Dokploy Model

- Dokploy Projects and Environments own the app.
- Dokploy native Postgres and Redis-compatible Dragonfly cache resources are
  created when Encore declares SQL databases or cache clusters.
- Dokploy Compose builds and runs the backend/frontend services plus generated
  support services such as NSQ for Pub/Sub and RustFS for Encore object storage
  buckets. Public buckets add a small RustFS public-route adapter so Dokploy can
  keep `/objects` on the app domain while backend S3 traffic stays internal.
- Dokploy Domains/Traefik route `/` to Nuxt, `/api` to Encore, and `/objects`
  to the RustFS public adapter only when a public Encore bucket is declared.
- Dokploy Schedules run Encore cron jobs inside the backend container through a
  bundled private runner; cron endpoints should use `api({ expose: false }, ...)`
  so they cannot be triggered from public HTTP.
- Encore `secret()` values are stored as Dokploy Compose environment variables
  through `nstack env set`, `nstack env push`, and deploy.

There is no Caddy container and no manual Traefik label surface in generated
Compose.

Cache resources are still addressed through Encore/Dokploy Redis connection
settings, but new Dokploy cache resources use the official Dragonfly image by
default. Existing Dokploy Redis resources are reused instead of replaced during
normal code deploys.

## Builds

The default build mode is `compose`: Dokploy receives a Compose file with
`build:` sections, local image tags, and production Dockerfiles. That path does
not need GHCR, Docker Hub, or any external image registry. The first deploy can
pay for dependency downloads on the server; consecutive deploys reuse Docker and
pnpm caches on the Dokploy host.

The Nuxt service is built with `nuxt build` and runs `.output/server/index.mjs`.
It is not deployed with a dev server.

Registry/image mode is still available when needed:

```sh
nstack configure --build-mode registry --registry ghcr.io/acme/my-app
nstack build
nstack deploy --prebuilt
```

## Files

- `nstack.config.mjs` is stable source config.
- `.nstack/local.env` stores local deploy settings and is ignored.
- `.nstack/secrets.env` stores local app runtime secrets and is ignored.
- `deploy/nstack/encore.infra.json` is passed to the backend runtime.
- `deploy/nstack/compose.dokploy.yaml` is sent to Dokploy Compose.
- `deploy/nstack/release.json` records the build mode and release from
  `nstack build`.

For staging or other targets, pass `--env <name>`. nstack writes target-scoped
files such as `.nstack/local.staging.env`, `.nstack/secrets.staging.env`, and
`.nstack/state.staging.json`. If multiple local targets exist, interactive
`nstack deploy` asks which environment to deploy; automation should pass
`--env <name>`.

Monorepos are supported without repo-in-repo layouts. Run nstack from the app
directory, for example `nstack deploy --cwd apps/web`; nstack scopes dirty Git
checks, generated deploy artifact commits, and client generation to that app.
For source-backed Dokploy deploys, subdirectory apps default to app-prefixed
Compose source settings such as `apps/web/deploy/nstack/compose.dokploy.yaml`
and `watchPaths: ["apps/web/**"]`, so multiple nstack apps can share one
repository without blocking each other.
