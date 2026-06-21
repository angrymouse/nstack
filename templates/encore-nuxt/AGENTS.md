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

- Install: `pnpm install`
- Develop: `pnpm dev` or `nstack dev`
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
- Keep `scripts/nstack-local.mjs` in the local dev/check path so fresh clones
  install missing pnpm dependencies and fail early with clear Encore CLI or
  Docker setup instructions. `nstack dev` prints an extra reminder when it
  detects an AI coding harness because the command is long-running.
- Keep backend resource declarations in Encore source. Let `nstack deploy`
  reconcile Dokploy from Encore metadata.
- If multiple local deploy targets exist, interactive `nstack deploy` asks for
  the environment. Use `--env <name>` in automation.
- Use `nstack env set`, `nstack env pull`, and `nstack env push` for runtime
  secrets. Never commit secret values.
- Keep generated deploy files and `.nstack/` state out of manual edits.
- Run `pnpm check` before considering the change complete.
