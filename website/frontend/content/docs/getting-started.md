---
title: Getting started
description: Install nstack and create a new Encore + Nuxt app.
navigation:
  title: Getting started
---

# Getting started

Install nstack, create the app, prepare local dependencies, and run the stack.

```bash
curl -fsSL https://nstack.playground.nik.technology/install.sh | bash
nstack init my-app
cd my-app
nstack setup
nstack dev
```

## When to run setup

Run `nstack setup` once after creating a new app or after cloning an existing generated app. It prepares dependencies and local config so `nstack dev` can run Encore and Nuxt together.

## What init creates

`nstack init my-app` creates an Encore backend, a Nuxt frontend, nstack deployment config, generated app docs for agents, and package scripts that route common workflows through the CLI.

## First local run

`nstack dev` rebuilds the typed Encore client and starts local development. API changes in Encore flow into the Nuxt app through generated client code.
