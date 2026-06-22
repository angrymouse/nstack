---
title: Deployment
description: Deploy Encore + Nuxt apps to Dokploy with nstack.
navigation:
  title: Deployment
---

# Deployment

Run deploy from the app directory.

```bash
nstack deploy
```

The deploy flow discovers Encore resources, renders deploy files, provisions the Dokploy target, rebuilds generated client code, deploys backend and frontend services, and verifies the published URL.

## Targets

Targets represent Dokploy environments such as production or staging.

```bash
nstack target create staging --domain staging.example.com
```

Use targets when the same app needs separate domains, secrets, resource instances, or deployment history.

## Generated deploy output

During deploy, nstack renders the resource plan and Dokploy service definitions from source. Treat those files as CLI output and change the app code or target config when the deploy shape needs to change.

## After deploy

Check status and follow logs from the same CLI.

```bash
nstack status
nstack logs --follow
```
