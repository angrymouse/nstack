# __APP_NAME__

Encore + Nuxt app deployed by `nstack`.

## Local

```sh
pnpm install
pnpm dev
```

## Deploy

Point the domain at your Dokploy server, then run:

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
