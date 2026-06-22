<script setup lang="ts">
import {
  PhArrowLeft,
  PhBookOpen,
  PhCloudArrowUp,
  PhCode,
  PhDatabase,
  PhDiscordLogo,
  PhGearSix,
  PhPackage,
  PhTerminalWindow,
} from "@phosphor-icons/vue";
import InspiraButton from "~/components/inspira/ui/button/InspiraButton.vue";
import InspiraSurface from "~/components/inspira/ui/surface/InspiraSurface.vue";

const installCommand =
  "curl -fsSL https://nstack.playground.nik.technology/install.sh | bash";
const discordInvite = "https://discord.gg/zHAJ4Ym5TP";

const runtimeConfig = useRuntimeConfig();
const siteUrl = String(
  runtimeConfig.public.siteUrl || "https://nstack.playground.nik.technology",
).replace(/\/$/, "");
const pageTitle = "nstack docs | Deploy Encore + Nuxt to Dokploy";
const pageDescription =
  "Install nstack, run Encore and Nuxt locally, provision Dokploy resources, and deploy from one CLI.";
const pageImage = `${siteUrl}/assets/og-image.png`;

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogSiteName: "nstack",
  ogType: "article",
  ogUrl: `${siteUrl}/docs`,
  ogImage: pageImage,
  ogImageAlt: "nstack documentation page with CLI workflow",
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogLocale: "en_US",
  twitterCard: "summary_large_image",
  twitterTitle: pageTitle,
  twitterDescription: pageDescription,
  twitterImage: pageImage,
});

useHead({
  link: [
    {
      rel: "canonical",
      href: `${siteUrl}/docs`,
    },
  ],
});

const quickLinks = [
  {
    icon: PhTerminalWindow,
    title: "Start a new app",
    body: "Install the CLI, create the project, run setup, then start Encore and Nuxt together.",
    href: "#start",
  },
  {
    icon: PhDatabase,
    title: "Provision resources",
    body: "Encore resource declarations become Dokploy resources during deploy.",
    href: "#resources",
  },
  {
    icon: PhCloudArrowUp,
    title: "Deploy targets",
    body: "Use targets for production, staging, and any Dokploy environment you configure.",
    href: "#deploy",
  },
];

const resourceRows = [
  {
    name: "SQL databases",
    detail: "Encore SQL databases map to Dokploy Postgres resources.",
  },
  {
    name: "Caches",
    detail: "Encore caches map to Dragonfly or Redis-compatible Dokploy services.",
  },
  {
    name: "Pub/Sub",
    detail: "Topics and subscriptions map to NSQ-backed services for the deployed app.",
  },
  {
    name: "Object storage",
    detail: "Encore buckets map to S3-compatible storage such as RustFS or MinIO.",
  },
  {
    name: "Cron jobs",
    detail: "Encore cron definitions become scheduled jobs for the target.",
  },
  {
    name: "Secrets",
    detail: "Secrets are stored as target-specific deployment environment values.",
  },
];

const fileRows = [
  {
    path: "nstack.config.mjs",
    detail: "App paths, provider, and target settings.",
  },
  {
    path: ".nstack/local.env",
    detail: "Local settings used by development commands.",
  },
  {
    path: ".nstack/secrets.env",
    detail: "Local secret values before they are pushed to a target.",
  },
  {
    path: "deploy/nstack/encore.infra.json",
    detail: "Resource plan discovered from Encore source.",
  },
  {
    path: "deploy/nstack/compose.dokploy.yaml",
    detail: "Dokploy compose output generated before deploy.",
  },
  {
    path: "frontend/app/generated/encore-client.ts",
    detail: "Typed client generated from the Encore API shape.",
  },
];

const commands = [
  {
    title: "Create and run",
    code: `${installCommand}
nstack init my-app
cd my-app
nstack setup
nstack dev`,
  },
  {
    title: "Deploy",
    code: `nstack deploy
nstack status
nstack logs --follow`,
  },
  {
    title: "Targets and operations",
    code: `nstack target create staging --domain staging.example.com
nstack env set API_SECRET
nstack backup
nstack pull
nstack rollback`,
  },
];
</script>

<template>
  <div class="page-shell min-h-dvh text-zinc-100">
    <a
      href="#docs-main"
      class="sr-only focus:not-sr-only focus:squircle-sm focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-zinc-100 focus:px-4 focus:py-3 focus:font-sans focus:font-extrabold focus:text-zinc-950"
    >
      Skip to content
    </a>

    <header class="fixed inset-x-0 top-0 z-40 px-5 md:px-8">
      <nav
        class="nav-bulb mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-5"
        aria-label="Primary"
      >
        <a href="/" class="flex items-center gap-3 text-zinc-50">
          <span class="logo-frame" aria-hidden="true">
            <img src="/assets/nstack-logo.png" alt="" class="size-7 object-contain">
          </span>
          <span class="font-display text-[22px] font-extrabold tracking-normal text-zinc-50">
            nstack
          </span>
        </a>

        <div class="hidden items-center gap-1 md:flex">
          <a
            href="/#workflow"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Workflow
          </a>
          <a
            href="/#deploy"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Deploy
          </a>
          <a
            href="/#commands"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Commands
          </a>
        </div>

        <InspiraButton as="a" href="/#install" size="sm" variant="secondary">
          Install
        </InspiraButton>
      </nav>
    </header>

    <main id="docs-main" class="mx-auto max-w-6xl px-5 pb-20 pt-28 md:px-8 md:pt-32">
      <section class="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
        <div>
          <a
            href="/"
            class="squircle-sm inline-flex items-center gap-2 px-2 py-1 text-[14px] font-bold text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
          >
            <PhArrowLeft :size="17" weight="bold" aria-hidden="true" />
            Back home
          </a>
          <h1 class="mt-7 max-w-3xl text-balance font-display text-5xl font-extrabold leading-[1.02] tracking-normal text-zinc-50 md:text-6xl">
            Docs for deploying Encore + Nuxt on Dokploy.
          </h1>
          <p class="mt-5 max-w-2xl text-pretty text-[18px] font-semibold leading-8 text-zinc-400 md:text-[20px]">
            nstack creates the app, keeps the Encore client synced, runs local
            development, provisions Dokploy resources, and owns the deployment
            pipeline for each target.
          </p>
          <div class="mt-7 flex flex-wrap gap-3">
            <InspiraButton as="a" href="#start" variant="rainbow" class="pastel-cta">
              <span class="pastel-cta-text">Start in 3 commands</span>
              <PhBookOpen :size="18" weight="bold" class="text-zinc-300" aria-hidden="true" />
            </InspiraButton>
            <InspiraButton
              as="a"
              :href="discordInvite"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
            >
              <PhDiscordLogo :size="18" weight="bold" aria-hidden="true" />
              Join Discord
            </InspiraButton>
          </div>
        </div>

        <InspiraSurface class="p-5 md:p-6">
          <p class="text-[14px] font-extrabold text-zinc-50">Recommended start</p>
          <pre class="squircle-md mt-4 overflow-x-auto border border-zinc-800 bg-zinc-950 p-4 text-[13px] font-semibold leading-6 text-zinc-300"><code>nstack init my-app
cd my-app
nstack setup
nstack dev</code></pre>
          <p class="mt-4 text-[14px] font-semibold leading-6 text-zinc-500">
            Use <code class="text-zinc-300">nstack setup</code> once for a new
            or freshly cloned app. It prepares dependencies and local config so
            <code class="text-zinc-300">nstack dev</code> can run both sides.
          </p>
        </InspiraSurface>
      </section>

      <section class="mt-14 grid gap-4 md:grid-cols-3">
        <a
          v-for="item in quickLinks"
          :key="item.title"
          :href="item.href"
          class="squircle-xl border border-zinc-800 bg-zinc-950 p-5 transition hover:border-zinc-700 hover:bg-zinc-900"
        >
          <component :is="item.icon" :size="25" weight="bold" class="text-zinc-200" aria-hidden="true" />
          <h2 class="mt-4 font-display text-2xl font-extrabold text-zinc-50">
            {{ item.title }}
          </h2>
          <p class="mt-2 text-[15px] font-semibold leading-6 text-zinc-400">
            {{ item.body }}
          </p>
        </a>
      </section>

      <section id="start" class="mt-16 grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
        <div class="lg:sticky lg:top-28">
          <PhTerminalWindow :size="30" weight="bold" class="text-zinc-300" aria-hidden="true" />
          <h2 class="mt-4 max-w-xl font-display text-4xl font-extrabold leading-tight text-zinc-50">
            Start locally.
          </h2>
          <p class="mt-4 max-w-xl text-[17px] font-semibold leading-8 text-zinc-400">
            The local loop is one command after setup. nstack rebuilds the typed
            client and runs Encore and Nuxt together, so API changes reach the
            frontend without a manual handoff.
          </p>
        </div>

        <div class="grid gap-4">
          <InspiraSurface
            v-for="command in commands"
            :key="command.title"
            tone="flat"
            class="p-5"
          >
            <h3 class="font-display text-2xl font-extrabold text-zinc-50">
              {{ command.title }}
            </h3>
            <pre class="squircle-md mt-4 overflow-x-auto border border-zinc-800 bg-zinc-950 p-4 text-[13px] font-semibold leading-6 text-zinc-300"><code>{{ command.code }}</code></pre>
          </InspiraSurface>
        </div>
      </section>

      <section id="resources" class="mt-16 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
        <InspiraSurface class="overflow-hidden">
          <div class="border-b border-zinc-800 p-5">
            <div class="flex items-center gap-3">
              <PhDatabase :size="26" weight="bold" class="text-zinc-200" aria-hidden="true" />
              <h2 class="font-display text-3xl font-extrabold text-zinc-50">
                Resource provisioning
              </h2>
            </div>
          </div>
          <div class="divide-y divide-zinc-800">
            <div
              v-for="row in resourceRows"
              :key="row.name"
              class="grid gap-2 p-5 md:grid-cols-[12rem_1fr]"
            >
              <p class="font-display text-[17px] font-extrabold text-zinc-100">
                {{ row.name }}
              </p>
              <p class="text-[15px] font-semibold leading-6 text-zinc-400">
                {{ row.detail }}
              </p>
            </div>
          </div>
        </InspiraSurface>

        <InspiraSurface id="deploy" class="p-5 md:p-6">
          <PhCloudArrowUp :size="28" weight="bold" class="text-zinc-200" aria-hidden="true" />
          <h2 class="mt-4 font-display text-3xl font-extrabold text-zinc-50">
            Deploy pipeline
          </h2>
          <p class="mt-4 text-[16px] font-semibold leading-7 text-zinc-400">
            <code class="text-zinc-200">nstack deploy</code> discovers Encore
            resources, renders deploy files, provisions the target in Dokploy,
            rebuilds generated client code, deploys backend and frontend
            services, and verifies the published URL.
          </p>
          <p class="mt-4 text-[16px] font-semibold leading-7 text-zinc-400">
            If Dokploy has a Git provider connected, nstack can use that source
            provider for deploys. Targets let the same app ship to production,
            staging, or another Dokploy environment.
          </p>
        </InspiraSurface>
      </section>

      <section class="mt-16 grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
        <div>
          <PhCode :size="30" weight="bold" class="text-zinc-300" aria-hidden="true" />
          <h2 class="mt-4 max-w-xl font-display text-4xl font-extrabold leading-tight text-zinc-50">
            Files nstack maintains.
          </h2>
          <p class="mt-4 max-w-xl text-[17px] font-semibold leading-8 text-zinc-400">
            Generated files stay in predictable locations, so humans and agents
            can inspect what changed before a deploy.
          </p>
        </div>

        <InspiraSurface class="overflow-hidden">
          <div
            v-for="row in fileRows"
            :key="row.path"
            class="grid gap-2 border-b border-zinc-800 p-5 last:border-b-0 md:grid-cols-[18rem_1fr]"
          >
            <code class="font-mono text-[13px] font-bold text-zinc-200">
              {{ row.path }}
            </code>
            <p class="text-[15px] font-semibold leading-6 text-zinc-400">
              {{ row.detail }}
            </p>
          </div>
        </InspiraSurface>
      </section>

      <section class="mt-16">
        <InspiraSurface class="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8">
          <div>
            <div class="flex items-center gap-3">
              <PhGearSix :size="27" weight="bold" class="text-zinc-300" aria-hidden="true" />
              <h2 class="font-display text-3xl font-extrabold text-zinc-50">
                Need help wiring Dokploy?
              </h2>
            </div>
            <p class="mt-4 max-w-2xl text-[17px] font-semibold leading-8 text-zinc-400">
              Bring your target setup questions, deploy logs, and generated
              file diffs to Discord. The fastest help usually starts with the
              command you ran and the target name.
            </p>
          </div>
          <div class="flex flex-col gap-3 sm:flex-row">
            <InspiraButton
              as="a"
              :href="discordInvite"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
            >
              <PhDiscordLogo :size="18" weight="bold" aria-hidden="true" />
              Join Discord
            </InspiraButton>
            <InspiraButton as="a" href="/" variant="quiet">
              <PhPackage :size="18" weight="bold" aria-hidden="true" />
              Landing page
            </InspiraButton>
          </div>
        </InspiraSurface>
      </section>
    </main>
  </div>
</template>
