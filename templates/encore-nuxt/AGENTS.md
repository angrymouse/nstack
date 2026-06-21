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

- Avoid binary contrast phrasing in prose, web design, reasoning, and
  documentation. The construction `it's not just <X>, it's <other, actual
  meaning>` and close variants such as `it is not just...` are very strongly
  discouraged. State the direct claim or tradeoff without that rhetorical
  construction. Also avoid chained negation followed by one asserted answer,
  such as `This is not a coincidence. That is not numerology. That is
  *structure*.` Prefer one clear positive statement. Avoid empty rule-of-three
  cadence used for rhetorical lift without substance, such as `They absorbed
  it. They adapted. They kept working.` Use one concrete sentence instead. Do
  not use em dashes. Avoid dot-style bullet presentation, including decorative
  bullet glyphs such as `•` and markdown bullets used for rhetorical emphasis.
  Do not treat this as a punctuation swap by replacing an em dash with a hyphen
  while keeping the same padded sentence structure. Hyphens are fine when they
  serve normal grammar; revise sentence shape, pacing, and information order.
  Avoid bullet points by default unless the user specifically asks for them or
  the content is naturally a technical list, checklist, command sequence, or
  reference table that benefits from scanning. Prefer short paragraphs when
  bullets add no clear value. Avoid filler words and padded lead-ins that are
  uncommon in normal technical conversation, such as `elevate`, `delve`, and
  `tackle`. Cut low-information sentences, especially parallel sentence
  structures that delay the useful point. Before sending prose, reread it and
  rewrite when it feels wordy, watery, or ceremonial. Avoid technical detail in
  prose and frontend copy unless it adds value in that specific paragraph or
  screen. Keep details that help the reader decide, act, or understand current
  state. Remove implementation facts that only make copy sound more technical.
  Avoid decorative badges, status pills, pulsing dots, and tiny uppercase
  subtitles when they do not carry real product or workflow meaning. Labels
  such as `LIVE`, `Open Source`, or section eyebrows should earn their place;
  otherwise remove them and let the heading or body copy do the work.
  For website and frontend copy, check every visible line after editing. Each
  line should tell the user what the product is, what they can do, what changed,
  or what command to run. Replace buzzphrases such as `Ship from the directory
  you already use` with concrete wording that names the real action.
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
- Use `nstack env set`, `nstack env pull`, and `nstack env push` for runtime
  secrets. Never commit secret values.
- Keep generated deploy files and `.nstack/` state out of manual edits.
- Run `pnpm check` before considering the change complete.
