# nstack

`nstack` is a small release layer for Encore + Nuxt apps on Dokploy.

It keeps the app shape boring:

```sh
nstack init my-app
cd my-app
pnpm install
nstack configure --domain app.example.com --dokploy-url https://dokploy.example.com --dokploy-api-key <key> --repository https://github.com/acme/my-app.git
nstack deploy
```

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
pnpm dev
pnpm check
nstack deploy
nstack status
```

Use `nstack env set NAME` for runtime secrets and `nstack logs --follow` when a
deploy is running.

## When Needed

```sh
nstack doctor
nstack pull
nstack rollback
nstack open dashboard
```

The generated app only exposes `dev`, `build`, `check`, `deploy`, and `status`
as package scripts. The rest stays in the `nstack` CLI so new projects do not
start with a wall of commands.

For the detailed operator guide, see [USING_NSTACK.md](USING_NSTACK.md).

## Dokploy Model

- Dokploy Projects and Environments own the app.
- Dokploy native Postgres and Redis are created when Encore declares SQL
  databases or cache clusters.
- Dokploy Compose builds and runs the backend/frontend services plus generated
  support services such as NSQ for Pub/Sub.
- Dokploy Domains/Traefik route `/` to Nuxt and `/api` to Encore.
- Dokploy Schedules run Encore cron jobs against the backend service.

There is no Caddy container and no manual Traefik label surface in generated
Compose.

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
`.nstack/state.staging.json`.
