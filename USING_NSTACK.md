# Using nstack

`nstack` is a release layer for Encore + Nuxt apps deployed on Dokploy. It keeps the generated app small, lets Dokploy build production containers from source, provisions the Dokploy resources the app needs, and verifies the public URL after deploy.

This guide covers the default Dokploy Compose workflow first. Registry image pushes are supported, but they are optional.

## Mental Model

nstack has three jobs:

1. Discover the app shape from Encore and `nstack.config.mjs`.
2. Render deploy artifacts for Dokploy: Encore infra config and Docker Compose.
3. Drive Dokploy: create or update the Compose app, resources, domains, schedules, env, deployments, verification, rollback state, and logs.

The generated app stays ordinary:

- `backend/` is an Encore TypeScript app.
- `frontend/` is a Nuxt app.
- Dokploy Domains/Traefik route traffic; nstack does not add Caddy or a proxy container.
- Dokploy Compose builds and runs backend and frontend containers.
- Dokploy native resources are used where they map to Encore resources.
- Encore cache resources are backed by Dokploy's Redis resource type, using
  Dragonfly as the Redis-compatible engine for new resources.
- Generated support services fill the remaining Encore primitives: NSQ for Pub/Sub and MinIO for object storage buckets.
- Encore `secret()` values are pushed as Dokploy Compose environment variables, not committed into source.

## Zero To Production

This is the full path from a plain SSH server and an empty local directory to a running production nstack app on Dokploy.

The example uses these placeholders:

```text
my-app                         local directory and app slug
app.example.com                public production domain
deploy.example.com             optional Dokploy panel domain
203.0.113.10                   server public IP
root@203.0.113.10              SSH login for the server
https://deploy.example.com     Dokploy panel URL after domain setup
https://github.com/acme/my-app.git
                               Git repository Dokploy can fetch
```

Use a host name for `--domain`, not a URL with `https://`.

### 1. Check Local Tools

You need Node 22 or newer and pnpm:

```sh
node --version
pnpm --version
```

If `nstack` is not globally installed, run it through the package manager or the local checkout you are using for nstack development. In a generated app, `nstack` is expected to be available on `PATH`.

### 2. Prepare The Server

Start with a Linux VPS or dedicated server you can SSH into as root or with sudo.

Recommended minimums:

- 2GB RAM.
- 30GB disk.
- Public IPv4 or IPv6 address.
- Ports 80, 443, and 3000 free.
- Ubuntu, Debian, Fedora, or CentOS family Linux.

SSH in:

```sh
ssh root@203.0.113.10
```

If you SSH as a non-root sudo user, prefix the server-side commands with `sudo`.

Update the server:

```sh
apt update
apt upgrade -y
```

If your distribution does not use `apt`, use the matching package manager.

Check that nothing is already listening on the ports Dokploy needs:

```sh
ss -tulnp | grep -E ':(80|443|3000) ' || true
```

If a firewall is enabled, allow HTTP, HTTPS, and the initial Dokploy UI port:

```sh
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw status
```

Only run `ufw enable` if you understand the current firewall state and SSH access is allowed.

### 3. Install Dokploy On The Server

Install Dokploy from the official installer:

```sh
curl -sSL https://dokploy.com/install.sh | sh
```

The installer installs Docker if needed, initializes the Dokploy stack, and starts the Dokploy UI.
The official Dokploy installation docs are at <https://docs.dokploy.com/docs/core/installation>; use the manual installation docs at <https://docs.dokploy.com/docs/core/manual-installation> when you need custom ports, custom networks, or an external database.

When it finishes, open:

```text
http://203.0.113.10:3000
```

Create the first Dokploy admin account in the browser.

If the server has multiple public/private addresses and the installer cannot pick the right Swarm advertise address, rerun with an explicit address:

```sh
export ADVERTISE_ADDR=203.0.113.10
curl -sSL https://dokploy.com/install.sh | sh
```

To update Dokploy later:

```sh
curl -sSL https://dokploy.com/install.sh | sh -s update
```

### 4. Point DNS At The Server

Point the app domain at the server before deploying. Use the record shape that matches your infrastructure:

```text
app.example.com  A      203.0.113.10
app.example.com  AAAA   <server-ipv6>
app.example.com  CNAME  <load-balancer-or-dokploy-host>
```

Only one of these shapes is usually needed. Check that DNS resolves before deploy:

```sh
dig +short app.example.com
```

If you want a domain for the Dokploy panel too, point `deploy.example.com` at the same server. Configure that domain in Dokploy and verify HTTPS works before disabling direct `:3000` access.

After the panel domain works, you can optionally remove direct IP port access on the server:

```sh
docker service update --publish-rm "published=3000,target=3000,mode=host" dokploy
```

Do not run that command until the panel domain works, or you can lock yourself out of the Dokploy UI.

### 5. Create A Dokploy API Key

In the Dokploy UI:

1. Finish admin account setup.
2. Create or confirm the project and environment you want to use, or let nstack create them during deploy.
3. Create an API key for nstack.
4. Keep the API key private. It belongs in `.nstack/local.env` or CI secrets, not in Git.

The Dokploy URL for nstack is either:

```text
https://deploy.example.com
```

or, before you configure a panel domain:

```text
http://203.0.113.10:3000
```

Use HTTPS for ongoing production use.

### 6. Create A Git Repository

Create an empty repository for the app, then copy its URL. The Dokploy server must be able to fetch it.

For provider-backed deploy-on-push, connect the matching Git provider in Dokploy before the first deploy. nstack can configure Dokploy Compose source deployments for:

- GitHub repositories when Dokploy has a GitHub provider/app connected.
- GitLab repositories when Dokploy has a GitLab provider connected, including self-hosted GitLab.
- Bitbucket repositories when Dokploy has a Bitbucket provider connected.
- Gitea or Forgejo repositories when Dokploy has a Gitea provider connected.

For a public repository, an HTTPS URL is usually enough for source builds:

```text
https://github.com/acme/my-app.git
```

For private repositories and automatic push deploys, prefer the native Dokploy provider integration for your Git host. Plain Git source mode can also clone custom repositories when configured with a Dokploy SSH key id, but native provider-backed sources are the route that gives Dokploy its normal push webhook behavior.

### 7. Scaffold The App

Create the app and install dependencies:

```sh
nstack init my-app
cd my-app
pnpm install
```

Interactive `nstack init` asks whether to set up Dokploy deployment now. If you say yes, it asks for the app domain, Dokploy URL, and API key, then lists the Git providers already connected in Dokploy. Pick the matching provider, or choose manual Git configuration for a new/custom source.

For automation or a scaffold-only run, use:

```sh
nstack init my-app --yes
nstack init my-app --no-deploy
```

The generated app contains an Encore backend, a Nuxt frontend, production Dockerfiles for Dokploy Compose, and a minimal `nstack.config.mjs`.

### 8. Run Local Checks

Run the generated checks before the first commit:

```sh
pnpm check
```

For local development:

```sh
pnpm dev
```

### 9. Commit And Push The Initial Source

Compose mode builds from Git on the Dokploy server. That means the source must be committed and pushed before a remote production deploy can build it.

```sh
git init
git remote add origin https://github.com/acme/my-app.git
git add .
git commit -m "init nstack app"
git branch -M main
git push -u origin main
```

If the repository already exists locally, use the normal `git remote`, `git add`, `git commit`, and `git push` flow for your project.

### 10. Link Or Adjust The Production Target

If you skipped the init deploy setup, or you want to change it, configure the production deploy target:

```sh
nstack configure \
  --domain app.example.com \
  --dokploy-url https://dokploy.example.com \
  --dokploy-api-key <key> \
  --repository https://github.com/acme/my-app.git \
  --branch main
```

Optional production settings:

```sh
nstack configure --project "My Project"
nstack configure --environment production
nstack configure --server-id <dokploy-server-id>
nstack configure --platform linux/amd64
```

This writes local deploy settings to `.nstack/local.env`. The file is ignored by Git and should not be committed.

For most GitHub, GitLab, Bitbucket, and Gitea/Forgejo apps, nstack can infer the provider from the repository host and the providers already connected in Dokploy. If there are multiple providers for the same host, or you are using GitLab subgroups, Bitbucket slugs, or plain Git, add the advanced source fields to `nstack.config.mjs`:

```js
export default {
  deploy: {
    source: {
      repository: "https://gitlab.example.com/platform/apps/my-app.git",
      branch: "main",
      sourceType: "gitlab",
      gitlabId: "<dokploy-gitlab-provider-id>",
      gitlabProjectId: 123,
      gitlabPathNamespace: "platform/apps/my-app",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: ["backend/**", "frontend/**", "deploy/nstack/**"],
    },
  },
};
```

Use `githubId`, `gitlabId`, `bitbucketId`, or `giteaId` to pin a specific Dokploy provider. For plain Git, use `sourceType: "git"` and `sshKeyId: "<dokploy-ssh-key-id>"` for private SSH repositories.

### 11. Add Runtime Secrets If Needed

The generated app does not require an app runtime secret by default. If your backend declares required secrets or your app reads environment variables at runtime, store them locally first:

```sh
nstack env set API_SECRET
```

Set from an existing shell variable:

```sh
API_SECRET=value nstack env set API_SECRET
```

Set without an interactive prompt:

```sh
printf '%s' "$API_SECRET" | nstack env set API_SECRET
```

Secrets are written to `.nstack/secrets.env`, which is ignored by Git. On deploy, nstack saves the needed Compose environment in Dokploy without printing secret values.

### 12. Preflight The Setup

Use doctor to catch missing local config, missing repository, invalid Dokploy credentials, or missing files:

```sh
nstack doctor
nstack doctor --check
```

Render once to inspect the deploy plan without deploying:

```sh
nstack render
```

The render command writes generated artifacts under `deploy/nstack/`. Commit those files for Dokploy source builds, because Dokploy reads the Compose file from the repository on push deployments.

### 13. Deploy To Production

Deploy:

```sh
nstack deploy
```

During the first deploy, nstack will:

- Discover Encore resources.
- Generate Encore infra config.
- Generate Dokploy Compose.
- Create or reuse the Dokploy project and environment.
- Create or reuse managed Postgres or Redis-compatible Dragonfly cache resources
  when Encore resources require them.
- Add generated support services for Encore Pub/Sub and object storage when required.
- Create or update the Dokploy Compose app.
- Save Compose environment values.
- Create or update Dokploy Domains/Traefik routes.
- Create or update Dokploy schedules for Encore cron jobs. These schedules run a
  bundled private cron runner inside the backend container, not public HTTP routes.
- Trigger the deployment.
- Wait for completion.
- Verify the public app.
- Save the verified release in `.nstack/state.json`.

The first Dokploy build can be slower because the server has to fetch base images, dependencies, and the pinned Encore toolchain. Consecutive deploys should be much faster when the same builder cache is retained.

### 14. Confirm Production Is Healthy

After deploy:

```sh
nstack status
nstack status --check
nstack verify
nstack open --print
```

Expected result:

- `nstack deploy` prints the deployed URL.
- `nstack verify` succeeds for `/api/ready`.
- `nstack status --check` exits successfully.
- Dokploy has a Compose app named `<slug>-app`.
- Dokploy Domains route `/` to `frontend:3000` and `/api` to `backend:8080`.
- Any declared schedules appear in Dokploy.
- `.nstack/state.json` contains the latest verified release.

If the deploy is still running or fails:

```sh
nstack logs --follow
nstack deployments
nstack inspect
```

### 15. Normal Production Change Loop

After the first production deploy, use this loop:

```sh
pnpm check
git add .
git commit -m "describe change"
git push
nstack deploy
nstack status --check
```

For source-only changes, the stable Docker layers should remain cached on Dokploy. The backend should not rerun Corepack, Encore download, SHA verification, extraction, or dependency install unless the Dockerfile, Encore version, package manifests, lockfile, base image, architecture, or builder cache changes.

## Generated Project Layout

Important files in a generated app:

```text
nstack.config.mjs              stable source config
backend/                       Encore backend
frontend/                      Nuxt frontend
backend/Dockerfile             production backend image for Dokploy Compose
frontend/Dockerfile            production Nuxt image for Dokploy Compose
.nstack/local.env              local deploy link settings, ignored
.nstack/secrets.env            local app runtime secrets, ignored
.nstack/state.json             local Dokploy state and release history, ignored
deploy/nstack/                 generated deploy artifacts, ignored
```

For non-production targets, nstack writes target-scoped files:

```text
.nstack/local.staging.env
.nstack/secrets.staging.env
.nstack/state.staging.json
```

The generated `.gitignore` ignores local secrets, deploy state, generated deploy artifacts, dependency folders, and build output.

## Configuration

The stable config lives in `nstack.config.mjs`. A minimal generated config looks like this:

```js
export default {
  app: {
    name: "my-app",
    slug: "my-app",
  },
  paths: {
    frontendContext: ".",
  },
  verify: {
    timeoutSeconds: 120,
    endpoints: [
      { name: "ready", path: "/api/ready", expectStatus: 200, expectCommit: true },
    ],
  },
};
```

Deploy-specific values are normally kept out of source and written by `nstack configure` into `.nstack/local.env`:

```text
NSTACK_DOMAIN=app.example.com
NSTACK_BUILD_MODE=compose
NSTACK_REPOSITORY=https://github.com/acme/my-app.git
DOKPLOY_URL=https://dokploy.example.com
DOKPLOY_API_KEY=...
```

Useful configure flags:

```sh
nstack configure --domain app.example.com
nstack configure --repository https://github.com/acme/my-app.git
nstack configure --branch main
nstack configure --dokploy-url https://dokploy.example.com
nstack configure --dokploy-api-key <key>
nstack configure --project "My Project"
nstack configure --environment production
nstack configure --server-id <dokploy-server-id>
nstack configure --platform linux/amd64
```

Use a host name for `--domain`, not a URL with `https://`.

## Build Modes

### Compose Mode

Compose mode is the default:

```sh
nstack configure --build-mode compose --repository https://github.com/acme/my-app.git
nstack deploy
```

In this mode, nstack sends Dokploy a Compose file with `build:` sections. Dokploy builds production backend and frontend images on the Dokploy server from the source repository.

This is the recommended default because it avoids external image registries and keeps deployment centered around Dokploy.

### Registry Mode

Use registry mode only when you want nstack to build and push images before deploying:

```sh
nstack configure --build-mode registry --registry ghcr.io/acme/my-app
nstack build
nstack deploy --prebuilt
```

Registry mode requires local Docker and registry credentials. Compose mode does not.

## Deploy Workflow

The usual production loop:

```sh
pnpm check
git add .
git commit -m "change"
git push
nstack deploy
```

For Compose source builds, the Dokploy server builds from Git. If your code is not committed and pushed to the configured repository or branch, Dokploy cannot build that exact change.

Useful deploy variants:

```sh
nstack render                 # render deploy artifacts only
nstack plan                   # alias for render
nstack build                  # render and run the local build path
nstack deploy --no-wait       # trigger deploy, return before verification
nstack wait                   # verify and promote the latest deployment attempt
nstack deploy --skip-verify   # deploy but do not promote lastRelease
nstack deploy --skip-status   # skip post-deploy Dokploy drift audit
```

`--skip-verify` is intentionally conservative: if verification is skipped, nstack does not mark the release as the last verified release.

## What Deploy Creates In Dokploy

On deploy, nstack can create or update:

- Dokploy project/environment lookup by name.
- A Dokploy Compose app.
- Dokploy native Postgres when Encore declares SQL databases.
- Dokploy native Redis-compatible Dragonfly cache resources when Encore declares
  cache resources.
- Compose services for backend, frontend, NSQ Pub/Sub, and RustFS object storage.
- Domains/Traefik routes for frontend, API traffic, and public object buckets.
- Compose environment variables for generated infrastructure credentials and Encore `secret()` values.
- Dokploy schedules for Encore cron jobs. Cron endpoints must be private
  (`api({ expose: false }, ...)`) so external callers cannot trigger them.

The generated Compose file is not meant to be hand-edited. Change source config, backend code, frontend code, or nstack config, then re-render or deploy.

Existing Dokploy Redis resources are reused by name and state id. A normal code
deploy does not recreate or repull the cache image; Dragonfly is the default for
new cache resources that nstack creates after this version.

## Daily Commands

Run locally:

```sh
pnpm dev
pnpm check
```

Deploy and inspect:

```sh
nstack deploy
nstack status
nstack logs --follow
```

Open URLs:

```sh
nstack open
nstack open dashboard
nstack open --print
nstack open dashboard --print
```

Use `--json` with commands when automation needs structured output:

```sh
nstack status --json
nstack deploy --json
nstack doctor --json
```

Use `--ci` to fail instead of prompting:

```sh
nstack deploy --ci
```

## Targets And Environments

Use `--env <name>` for a separate target such as staging:

```sh
nstack configure --env staging \
  --domain staging.example.com \
  --dokploy-url https://dokploy.example.com \
  --dokploy-api-key <key> \
  --repository https://github.com/acme/my-app.git \
  --branch staging
```

Deploy staging:

```sh
nstack deploy --env staging
nstack status --env staging
nstack logs --env staging --follow
```

List local targets:

```sh
nstack targets
nstack targets --json
```

Target files are independent, so production and staging keep separate local link settings, secrets, state, and release history.

## Runtime Secrets

App runtime secrets are separate from deploy credentials. When Encore declares `secret("NAME")`, nstack expects a `NAME` value and renders the Encore infra config to read it from the process environment. Deploy and `nstack env push` save those values into Dokploy Compose environment variables without printing them.

Set a secret:

```sh
nstack env set API_SECRET
```

Set from an environment variable:

```sh
API_SECRET=value nstack env set API_SECRET
```

Set from stdin:

```sh
printf '%s' "$API_SECRET" | nstack env set API_SECRET
```

List secret names without printing values:

```sh
nstack env list
nstack env list --json
```

Remove a secret:

```sh
nstack env unset API_SECRET
```

Push local app env to Dokploy:

```sh
nstack env push
```

Save env without redeploying:

```sh
nstack env push --stage
```

Pull env and state from Dokploy:

```sh
nstack pull
nstack env pull
```

Pull every remote app env key into local secrets:

```sh
nstack env pull --all
```

Run a local command with deploy env and app secrets loaded:

```sh
nstack env run -- pnpm check
```

## Status, Verification, And Drift

`nstack status` reports local config, saved release state, discovered resources, remote Dokploy state, and drift.

```sh
nstack status
nstack status --check
nstack status --json
```

`--check` exits nonzero when the status is not converged.

Verification uses the endpoints in `nstack.config.mjs`. A generated app verifies:

- `/api/ready` returns a lightweight backend readiness response.
- The readiness endpoint can be required to match the deployed commit.

Generated apps also include `/api/status` for richer DB-backed checks; keep that
for app-specific verification when you want slower end-to-end probes.

Run verification directly:

```sh
nstack verify
nstack verify --json
```

## Logs And Deployment Operations

Show recent deployments:

```sh
nstack deployments
nstack deployments --limit 5
nstack deployments --status running,failed
```

Inspect one deployment:

```sh
nstack inspect <deployment-id>
nstack deployments inspect <deployment-id>
```

Read logs:

```sh
nstack logs
nstack logs --tail 300
nstack logs <deployment-id>
nstack logs <deployment-id> --follow
```

Cancel an active deployment:

```sh
nstack cancel
nstack cancel <deployment-id>
```

Retry the latest saved release:

```sh
nstack redeploy
```

Wait after a `--no-wait` deploy:

```sh
nstack wait
```

## Rollback

Rollback uses locally saved verified release history.

Rollback to the previous verified release:

```sh
nstack rollback
```

Rollback to a saved tag or commit prefix:

```sh
nstack rollback <tag-or-commit>
```

Trigger rollback without waiting:

```sh
nstack rollback --no-wait
```

Rollback works best when every successful deployment has been verified by nstack, because only verified releases are promoted into the release history.

## Recovering State

If local `.nstack` files were deleted or you are on a new machine:

```sh
nstack configure --domain app.example.com --dokploy-url https://dokploy.example.com --dokploy-api-key <key> --repository https://github.com/acme/my-app.git
nstack pull
nstack status
```

`nstack pull` hydrates known Dokploy IDs, generated infrastructure secrets for Postgres, Redis, and MinIO, schedules, and remote app env. It preserves local secret values unless you explicitly force replacement. `nstack env pull --all` still filters generated `NSTACK_*` infrastructure keys out of `.nstack/secrets.env`.

## Performance Notes

For Dokploy Compose builds, the first deploy on a new builder can be slower because Docker must fetch base images, pnpm dependencies, Nuxt dependencies, and the pinned Encore toolchain.

Consecutive deploys should be much faster when:

- The same Dokploy builder handles the app.
- Docker/BuildKit cache is not cleared.
- `node:22-bookworm-slim`, `pnpm@10.18.3`, and the pinned Encore version do not change.
- Only app source changes.
- Dependency manifests and lockfiles are unchanged.

The backend Dockerfile intentionally puts stable toolchain layers before source copies. Changing backend source should not rerun Corepack, the Encore tarball download, SHA verification, extraction, or backend dependency install. It should rerun the combined hot build step for Encore wrapper generation, bundling, metadata, runtime copy, and image export.

Frontend source changes rerun the Nuxt build, but should not rerun frontend dependency installation unless `package.json` or the lockfile changes.

Avoid these during normal Dokploy deploys:

- Clearing Docker builder cache.
- Recreating the Dokploy Compose app unnecessarily.
- Sending local `node_modules` or build output in the Docker context.
- Switching build servers for the same app.
- Building with `--no-cache`.

## CI Usage

A minimal CI check can run:

```sh
pnpm install
pnpm check
nstack render --ci
```

A CI deploy can run:

```sh
nstack deploy --ci --no-wait
```

Then a later step or operator can run:

```sh
nstack wait --ci
```

Use environment variables for CI instead of committing `.nstack/local.env`:

```sh
NSTACK_DOMAIN=app.example.com
NSTACK_REPOSITORY=https://github.com/acme/my-app.git
DOKPLOY_URL=https://dokploy.example.com
DOKPLOY_API_KEY=...
```

## Troubleshooting

Run doctor first:

```sh
nstack doctor
nstack doctor --check
nstack doctor --json
```

Common issues:

- `nstack.config.mjs not found`: run inside the app directory or pass `--cwd`.
- Missing repository in Compose mode: run `nstack configure --repository <git-url>`.
- Dokploy cannot build latest code: commit and push the source, then deploy again.
- Domain verification fails: check DNS, Dokploy Domains, and `nstack status`.
- Backend cannot reach Postgres, Redis, or object storage: run `nstack status --json` and check generated env against Dokploy Compose env.
- A deploy is active too long: run `nstack logs --follow`, then `nstack cancel` if needed.
- A deploy failed after triggering: run `nstack logs`, then `nstack redeploy` or `nstack rollback`.
- Local state is stale: run `nstack pull`, then `nstack status`.

Useful debugging commands:

```sh
nstack render --json
nstack status --json
nstack deployments --json
nstack inspect --json
nstack logs --tail 500
```

## Command Reference

Project setup:

```sh
nstack init [dir]
nstack init [dir] --name "My App" --slug my-app
nstack init [dir] --force --yes
```

Link or update deploy settings:

```sh
nstack configure [options]
nstack config [options]
nstack link [options]
nstack unlink
```

Planning, build, deploy:

```sh
nstack render
nstack plan
nstack build
nstack deploy
nstack wait
nstack redeploy
nstack rollback [tag-or-commit]
```

Runtime env:

```sh
nstack env list
nstack env set NAME [value]
nstack env unset NAME
nstack env pull
nstack env push
nstack env push --stage
nstack env run -- <command>
```

Inspection:

```sh
nstack doctor
nstack status
nstack verify
nstack targets
nstack deployments
nstack inspect [deployment-id]
nstack logs [deployment-id]
nstack cancel [deployment-id]
nstack open [dashboard]
```

Global useful flags:

```text
--cwd <dir>              run against another app directory
--env <name>             use a target such as staging
--json                   print machine-readable output where supported
--ci                     fail instead of prompting
--yes                    fail instead of prompting
--no-wait                trigger deploy and return before verification
--skip-verify            skip public verification and do not promote release
--skip-status            skip post-deploy Dokploy status audit
--follow, -f             follow logs
--tail <n>               log line count
--limit <n>              deployment list limit
--status <list>          deployment status filter
```

## Practical Defaults

Use these defaults unless you have a reason not to:

- Use Compose mode.
- Use Dokploy Domains/Traefik, not a proxy container.
- Keep deploy credentials in `.nstack/local.env` or CI env vars, not source.
- Keep app runtime secrets in `.nstack/secrets.env` or Dokploy env, not source.
- Commit and push before remote Dokploy deploys.
- Let nstack verify deploys before considering them released.
- Use `nstack status --check` after manual Dokploy changes.
