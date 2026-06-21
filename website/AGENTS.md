# Agent Instructions

This is an nstack app: Encore.ts backend, Nuxt frontend, and Dokploy deployment
through generated Docker Compose artifacts.

Before changing code, read [NSTACK_GUIDELINES.md](./NSTACK_GUIDELINES.md).

## Project Map

- `backend/`: Encore.ts services, APIs, resources, migrations, and secrets.
- `frontend/`: Nuxt app served by the production Node server.
- `nstack.config.mjs`: source-controlled app/deploy shape. Do not put secrets here.
- `.nstack/`: local deploy target state and secrets. This directory is ignored.
- `deploy/nstack/`: generated deploy artifacts. Do not hand-edit these files.

## Commands

- Install/setup: `nstack setup` or `pnpm setup`
- Develop: `pnpm dev` or `nstack dev`
- One-shot dev check: `nstack devexec '<js>'`
- Check: `pnpm check`
- Deploy: `nstack deploy`
- Status: `nstack status`
- Backup: `nstack backup`
- Logs: `nstack logs --follow`

## Working Rules

- For new features, prefer idiomatic Encore and Nuxt abstractions over legacy
  local conventions: Encore APIs and generated clients, SQL databases, caches,
  Pub/Sub topics, WebSockets, and other Encore resources where they fit. Follow
  existing patterns when they remain healthy, but do not preserve old
  conventions that add unnecessary layering or turn the app into
  enterprise-style legacy code.
- Use `apiClient()` from `frontend/app/utils/api.ts` for frontend calls to
  Encore APIs. Normal `pnpm dev`/`nstack dev`, `pnpm check`, `pnpm build`, and
  `nstack deploy` commands keep `frontend/app/generated/encore-client.ts`
  in sync using local Encore metadata; Encore Cloud login is not required.
- Keep `backend/encore.app` `id` empty unless intentionally linking the repo to
  Encore Cloud. nstack uses `nstack.config.mjs` `app.slug` as the Dokploy/nstack
  identity; an empty Encore id keeps local `encore run` and `encore check` from
  fetching Encore Cloud secrets.
- Keep `scripts/nstack-local.mjs` in the local setup/dev/check path so fresh
  clones install dependencies, bootstrap pnpm through Corepack, install the
  Encore CLI when it is missing, and stop with clear Docker instructions only
  when Docker is needed but unavailable. Under AI coding harnesses, use
  `nstack devexec '<js>'` for one-shot dev-server checks. `nstack dev` is
  blocked unless `AI_ALLOW_DEVSERVER=1` is set because it starts long-running
  servers.
- Keep backend resource declarations in Encore source. Let `nstack deploy`
  reconcile Dokploy from Encore metadata.
- If multiple local deploy targets exist, interactive `nstack deploy` asks for
  the environment. Use `--env <name>` in automation.
- This app can live in a monorepo. Run commands from this app directory or pass
  `--cwd <app-dir>`; nstack scopes generated deploy artifacts, client sync, and
  source-backed Git dirty checks to this app. Subdirectory source-backed deploys
  default to app-prefixed Dokploy `composePath` and `watchPaths`, so sibling
  nstack apps in the same repo do not block each other.
- In prose and frontend copy, avoid technical detail unless it helps the reader
  decide, act, or understand current state. Remove implementation facts that
  only make copy sound more technical.
- Avoid decorative badges, status pills, pulsing dots, and tiny uppercase
  subtitles when they do not carry real product or workflow meaning.
- Check every visible line of website copy after editing. Each line should tell
  the user what nstack is, what they can do, what changed, or what command to
  run. Replace buzzphrases with concrete wording that names the real action.
- Use `nstack env set`, `nstack env pull`, and `nstack env push` for runtime
  secrets. Never commit secret values.
- Keep generated deploy files and `.nstack/` state out of manual edits.
- Run `pnpm check` before considering the change complete.
