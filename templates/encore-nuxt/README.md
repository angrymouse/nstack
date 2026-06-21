# __APP_NAME__

Encore + Nuxt app deployed by `nstack`.

## Local

```sh
pnpm dev
# or
nstack dev
```

`nstack init` installs dependencies and approves pnpm build scripts before the
initial git commit. If this app was copied manually, run `pnpm install` and
`pnpm approve-builds --all` first.

The Nuxt frontend calls Encore through `apiClient()` in
`frontend/app/utils/api.ts`, backed by the generated client in
`frontend/app/generated/encore-client.ts`. `pnpm dev` and `nstack dev` run the
same local orchestrator: Encore backend, generated client watcher, and Nuxt
frontend. On a fresh clone, `pnpm dev` and `pnpm check` install missing pnpm
dependencies before starting local work. They also fail early with direct setup
instructions when the Encore CLI or Docker daemon is missing. The watcher only
rewrites the client when the generated output changes, so Nuxt HMR is not
triggered by backend edits that leave the API surface unchanged. `pnpm check`,
`pnpm build`, and `nstack deploy` keep it updated automatically. Use
`nstack client gen` only when you explicitly want to regenerate it. Generation
and deploy metadata use local Encore commands for Dokploy/nstack targets;
Encore Cloud login is not required.

## Deploy

Point the domain at your Dokploy server. If this app was not linked during
`nstack init`, run:

```sh
nstack configure --domain <domain> --dokploy-url https://dokploy.example.com --dokploy-api-key <key> --repository https://github.com/acme/__APP_SLUG__.git
nstack deploy
```

After that, the usual loop is small:

```sh
pnpm check
nstack deploy
nstack status
```

If this app has multiple local deploy targets, interactive `nstack deploy` asks
which environment to deploy. Automation should pass `--env <name>`.

Deploy settings live in `.nstack/local.env`. App runtime secrets live in
`.nstack/secrets.env`.

For deploy-on-push, connect the matching Git provider in Dokploy first. nstack
can configure provider-backed Compose sources for GitHub, GitLab, Bitbucket, and
Gitea/Forgejo. Use `deploy.source` in `nstack.config.mjs` for advanced provider
fields such as explicit provider ids, GitLab path namespace, Bitbucket slug, or
custom plain-Git SSH key id.

## Secrets

```sh
nstack env set API_SECRET
nstack env push
```

Use `nstack env pull --all` when remote env changed and you want to refresh
local secrets.

## Recovery

```sh
nstack doctor
nstack logs --follow
nstack pull
nstack rollback
```

`nstack` provisions declared Encore resources automatically. Dokploy
Domains/Traefik handle ingress; there is no proxy container in this template.
By default Dokploy builds the production Nuxt server and Encore backend from
source through Compose, so no external image registry is required.

Encore cron jobs are registered as Dokploy schedules. Keep cron endpoints
private with `api({ expose: false }, ...)`; Dokploy executes them through the
bundled backend cron runner instead of calling a public HTTP route.
