---
title: Commands
description: Common nstack commands for local development and deployment.
navigation:
  title: Commands
---

# Commands

## Create and run

```bash
nstack init my-app
cd my-app
nstack setup
nstack dev
```

## Deploy and inspect

```bash
nstack deploy
nstack status
nstack logs --follow
```

## Targets and operations

```bash
nstack target create staging --domain staging.example.com
nstack env set API_SECRET
nstack backup
nstack pull
nstack rollback
```

## Agent helper

```bash
nstack devexec 'console.log("ready")'
```
