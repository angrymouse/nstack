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
- Develop: `pnpm dev`
- Check: `pnpm check`
- Deploy: `nstack deploy`
- Status: `nstack status`
- Backup: `nstack backup`
- Logs: `nstack logs --follow`

## Working Rules

- Prefer the existing Encore/Nuxt patterns in this repo over introducing new
  framework conventions.
- Keep backend resource declarations in Encore source. Let `nstack deploy`
  reconcile Dokploy from Encore metadata.
- Use `nstack env set`, `nstack env pull`, and `nstack env push` for runtime
  secrets. Never commit secret values.
- Keep generated deploy files and `.nstack/` state out of manual edits.
- Run `pnpm check` before considering the change complete.
