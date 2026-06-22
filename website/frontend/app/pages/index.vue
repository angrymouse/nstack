<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import {
  PhArrowRight,
  PhBracketsCurly,
  PhCheckCircle,
  PhCloudArrowUp,
  PhCode,
  PhCopy,
  PhFolderSimple,
  PhGitBranch,
  PhPlay,
  PhTerminalWindow,
} from "@phosphor-icons/vue";
import InspiraButton from "~/components/inspira/ui/button/InspiraButton.vue";
import InspiraSurface from "~/components/inspira/ui/surface/InspiraSurface.vue";

const installCommand =
  "curl -fsSL https://nstack.playground.nik.technology/install.sh | bash";
const copiedInstall = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const copyInstall = async () => {
  await navigator.clipboard.writeText(installCommand);
  copiedInstall.value = true;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedInstall.value = false;
  }, 1600);
};

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

const quickStart = [
  {
    icon: PhTerminalWindow,
    label: "Install",
    command: installCommand,
  },
  {
    icon: PhFolderSimple,
    label: "Create",
    command: "nstack init my-app",
  },
  {
    icon: PhPlay,
    label: "Run locally",
    command: "cd my-app && nstack dev",
  },
];

const workflow = [
  {
    icon: PhTerminalWindow,
    title: "Three-command start",
    body: "Install nstack, create an app, and run the full local stack before you configure deployment.",
  },
  {
    icon: PhBracketsCurly,
    title: "Encore-shaped backend",
    body: "APIs, databases, caches, Pub/Sub, and object storage live in source, so the architecture stays visible as the app grows.",
  },
  {
    icon: PhCode,
    title: "Agent-ready frontend",
    body: "Generated app docs guide agents toward real typography, concrete copy, and screens that feel authored.",
  },
  {
    icon: PhCloudArrowUp,
    title: "Dokploy deploy",
    body: "nstack provisions the app, routes, domains, and resource wiring from the same project shape.",
  },
];

const deployChecks = [
  "Encore resources are discovered from source",
  "Dokploy services are rendered from the app shape",
  "Generated clients sync before local runs, builds, and deploys",
  "Targets can be reused for staging and production",
];

useHead({
  title: "nstack",
  meta: [
    {
      name: "description",
      content:
        "Develop scalable, opinionated, AI-focused full stack apps with Encore, Nuxt, and Dokploy in three CLI commands.",
    },
    {
      property: "og:title",
      content: "nstack",
    },
    {
      property: "og:description",
      content:
        "Develop scalable, opinionated, AI-focused full stack apps with Encore, Nuxt, and Dokploy in three CLI commands.",
    },
    {
      property: "og:image",
      content: "/assets/nstack-hero.webp",
    },
  ],
  link: [
    {
      rel: "icon",
      type: "image/png",
      href: "/favicon.png",
    },
    {
      rel: "apple-touch-icon",
      href: "/assets/nstack-logo-192.png",
    },
    {
      rel: "preconnect",
      href: "https://fonts.googleapis.com",
    },
    {
      rel: "preconnect",
      href: "https://fonts.gstatic.com",
      crossorigin: "",
    },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600&family=Nunito+Sans:wght@500;600;700;800;900&display=swap",
    },
  ],
});
</script>

<template>
  <div class="page-shell min-h-dvh text-zinc-100">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:squircle-sm focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-zinc-100 focus:px-4 focus:py-3 focus:font-sans focus:font-extrabold focus:text-zinc-950"
    >
      Skip to content
    </a>

    <header class="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-xl">
      <nav
        class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 md:px-8"
        aria-label="Primary"
      >
        <a href="#main" class="flex items-center gap-3 text-zinc-50">
          <span class="logo-frame" aria-hidden="true">
            <img src="/assets/nstack-logo.png" alt="" class="size-7 object-contain">
          </span>
          <span class="font-display text-[22px] font-extrabold tracking-normal text-zinc-50">
            nstack
          </span>
        </a>

        <div class="hidden items-center gap-1 md:flex">
          <a
            href="#workflow"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Workflow
          </a>
          <a
            href="#deploy"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Deploy
          </a>
          <a
            href="#commands"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Commands
          </a>
        </div>

        <InspiraButton as="a" href="#install" size="sm" variant="secondary">
          Install
        </InspiraButton>
      </nav>
    </header>

    <main id="main">
      <section class="hero-section">
        <div class="hero-grid mx-auto grid max-w-6xl gap-10 px-5 pb-16 pt-14 md:px-8 md:pb-24 md:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
          <div>
            <h1 class="max-w-3xl text-balance font-display text-5xl font-extrabold leading-[0.98] tracking-normal text-zinc-50 md:text-7xl">
              Develop <span class="pastel-text">scalable, opinionated, AI-focused</span>
              full stack apps.
            </h1>
            <p class="mt-6 max-w-2xl text-pretty text-[19px] font-semibold leading-8 text-zinc-300 md:text-[21px]">
              Three commands create the app, run Encore and Nuxt locally, and
              deploy to Dokploy. The generated project starts with architecture
              that can grow under real traffic.
            </p>

            <div class="mt-8 flex flex-col gap-3 sm:flex-row">
              <InspiraButton as="a" href="#install" variant="rainbow">
                Start in 3 commands
                <PhArrowRight :size="18" weight="bold" class="text-amber-100" aria-hidden="true" />
              </InspiraButton>
              <InspiraButton as="a" href="#workflow" variant="quiet">
                See architecture
              </InspiraButton>
            </div>
          </div>

          <InspiraSurface id="install" class="hero-command-panel p-4 md:p-5">
            <div class="flex items-start justify-between gap-5">
              <div>
                <p class="text-[15px] font-extrabold text-zinc-50">Start in one shell</p>
                <p class="mt-1 text-[14px] font-semibold leading-6 text-zinc-400">
                  Run the installer, then create an app with
                  <code class="text-zinc-200">nstack init my-app</code>.
                </p>
              </div>
              <button
                type="button"
                class="squircle-sm inline-flex size-10 shrink-0 items-center justify-center border border-rose-200/35 bg-zinc-950/80 text-zinc-200 transition hover:border-amber-200/70 hover:text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/70 active:translate-y-px"
                :aria-label="copiedInstall ? 'Install command copied' : 'Copy install command'"
                @click="copyInstall"
              >
                <PhCheckCircle v-if="copiedInstall" :size="19" weight="bold" />
                <PhCopy v-else :size="19" weight="bold" />
              </button>
            </div>
            <pre class="squircle-md mt-5 whitespace-pre-wrap break-all border border-zinc-800 bg-zinc-950/92 p-4 text-[13px] leading-6 text-zinc-200"><code>{{ installCommand }}</code></pre>
          </InspiraSurface>
        </div>
      </section>

      <section id="commands" class="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
        <div class="grid gap-3 md:grid-cols-3">
          <InspiraSurface
            v-for="item in quickStart"
            :key="item.label"
            tone="soft"
            class="command-card p-5"
          >
            <div class="flex items-center gap-3">
              <span class="command-icon squircle-sm grid size-10 place-items-center text-zinc-100">
                <component :is="item.icon" :size="21" weight="bold" />
              </span>
              <p class="font-display text-xl font-extrabold text-zinc-50">
                {{ item.label }}
              </p>
            </div>
            <pre class="squircle-md mt-5 whitespace-pre-wrap break-all bg-zinc-950 p-3 text-[12px] font-semibold leading-5 text-zinc-300"><code>{{ item.command }}</code></pre>
          </InspiraSurface>
        </div>
      </section>

      <section id="workflow" class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <div class="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div class="lg:sticky lg:top-28">
            <h2 class="max-w-xl text-balance font-display text-4xl font-extrabold leading-tight text-zinc-50 md:text-5xl">
              Architecture agents can keep working with.
            </h2>
            <p class="mt-5 max-w-xl text-pretty text-[18px] font-semibold leading-8 text-zinc-400">
              nstack gives agents a real project shape: typed APIs, resource
              declarations, frontend rules, and deployment paths that stay
              visible in source.
            </p>
          </div>

          <div class="space-y-4">
            <InspiraSurface
              v-for="step in workflow"
              :key="step.title"
              tone="flat"
              class="grid gap-5 p-5 md:grid-cols-[3.5rem_1fr] md:p-6"
            >
              <div class="squircle-md grid size-14 place-items-center border border-zinc-800 bg-zinc-900 text-zinc-100">
                <component :is="step.icon" :size="27" weight="bold" />
              </div>
              <div>
                <h3 class="font-display text-2xl font-extrabold text-zinc-50">
                  {{ step.title }}
                </h3>
                <p class="mt-2 text-[17px] font-semibold leading-7 text-zinc-400">
                  {{ step.body }}
                </p>
              </div>
            </InspiraSurface>
          </div>
        </div>
      </section>

      <section class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <InspiraSurface class="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
          <div class="p-5 md:p-8">
            <div class="squircle-lg border border-zinc-800 bg-zinc-950">
              <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <div class="flex items-center gap-2 text-[13px] font-extrabold text-zinc-200">
                  <PhFolderSimple :size="17" weight="bold" aria-hidden="true" />
                  <span>my-app</span>
                </div>
                <code class="text-[12px] font-semibold text-zinc-500">nstack init</code>
              </div>
              <div class="grid gap-0 md:grid-cols-[0.8fr_1.2fr]">
                <div class="border-b border-zinc-800 p-4 md:border-b-0 md:border-r">
                  <div class="space-y-2 text-[13px] font-bold leading-6 text-zinc-400">
                    <p class="text-zinc-200">backend/</p>
                    <p class="pl-4">api.ts</p>
                    <p class="text-zinc-200">frontend/</p>
                    <p class="pl-4">app/</p>
                    <p class="text-zinc-200">deploy/nstack/</p>
                    <p>nstack.config.mjs</p>
                  </div>
                </div>
                <div class="p-4">
                  <pre class="overflow-x-auto text-[13px] font-semibold leading-7 text-zinc-300"><code>await api.health()

export const hello = api(
  { method: "GET", path: "/hello" },
  async () => ({ message: "ready" })
)</code></pre>
                </div>
              </div>
            </div>
          </div>
          <div class="border-t border-zinc-800 p-6 md:p-8 lg:border-l lg:border-t-0">
            <h2 class="max-w-lg text-balance font-display text-3xl font-extrabold leading-tight text-zinc-50 md:text-4xl">
              Start from a production-shaped app.
            </h2>
            <p class="mt-4 text-[17px] font-semibold leading-8 text-zinc-400">
              The template gives agents clear ownership boundaries: Encore APIs
              and resources, Nuxt screens, generated client code, and
              nstack-managed deploy artifacts.
            </p>

            <div class="squircle-lg mt-7 border border-zinc-800 bg-zinc-950 p-4">
              <div class="flex items-center gap-2 text-[13px] font-bold text-zinc-500">
                <PhGitBranch :size="17" weight="bold" aria-hidden="true" />
                <span>Project shape</span>
              </div>
              <pre class="mt-4 overflow-x-auto text-[13px] font-semibold leading-7 text-zinc-300"><code>backend/
frontend/
deploy/nstack/
nstack.config.mjs
package.json</code></pre>
            </div>
          </div>
        </InspiraSurface>
      </section>

      <section id="deploy" class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <div class="grid gap-6 lg:grid-cols-[0.95fr_1.05fr] lg:items-stretch">
          <InspiraSurface class="p-5 md:p-8">
            <div class="squircle-lg overflow-hidden border border-zinc-800 bg-zinc-950">
              <img
                src="/assets/nstack-deploy.webp"
                alt="Dokploy deployment view for an nstack app"
                class="aspect-[16/11] w-full object-cover opacity-90"
              >
            </div>
          </InspiraSurface>

          <InspiraSurface class="flex flex-col justify-between p-6 md:p-8">
            <div>
              <h2 class="max-w-xl text-balance font-display text-4xl font-extrabold leading-tight text-zinc-50 md:text-5xl">
                Deploy the same architecture.
              </h2>
              <p class="mt-5 max-w-2xl text-[18px] font-semibold leading-8 text-zinc-400">
                Run <code class="text-zinc-200">nstack deploy</code> from the
                app directory. The CLI prepares deploy files, provisions
                resources, and applies the Dokploy target you choose.
              </p>

              <div class="mt-7 grid gap-3">
                <div
                  v-for="item in deployChecks"
                  :key="item"
                  class="squircle-lg flex gap-3 border border-zinc-800 bg-zinc-950 p-4"
                >
                  <PhCheckCircle :size="20" weight="bold" class="mt-0.5 shrink-0 text-zinc-200" />
                  <span class="text-[15px] font-bold leading-6 text-zinc-300">
                    {{ item }}
                  </span>
                </div>
              </div>
            </div>

            <div class="mt-8 flex flex-col gap-3 sm:flex-row">
              <InspiraButton as="a" href="#commands" variant="secondary">
                Review commands
              </InspiraButton>
              <InspiraButton as="a" href="#install" variant="quiet">
                Install nstack
              </InspiraButton>
            </div>
          </InspiraSurface>
        </div>
      </section>

      <section class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <InspiraSurface class="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8">
          <div>
            <h2 class="font-display text-3xl font-extrabold text-zinc-50 md:text-4xl">
              Three-command loop
            </h2>
            <p class="mt-3 max-w-2xl text-[17px] font-semibold leading-8 text-zinc-400">
              Use this path for a new app. Add
              <code class="text-zinc-200">nstack deploy</code> after the
              Dokploy target is configured.
            </p>
          </div>
          <div class="squircle-lg grid gap-2 border border-zinc-800 bg-zinc-950 p-4 text-[13px] font-semibold leading-6 text-zinc-300">
            <span>nstack init my-app</span>
            <span>cd my-app</span>
            <span>nstack dev</span>
            <span>nstack deploy</span>
          </div>
        </InspiraSurface>
      </section>
    </main>

    <footer class="border-t border-zinc-800">
      <div class="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-[14px] font-semibold text-zinc-500 md:flex-row md:items-center md:justify-between md:px-8">
        <p>nstack builds AI-ready Encore and Nuxt apps for Dokploy.</p>
        <div class="flex gap-4">
          <a href="#install" class="transition hover:text-zinc-100">Install</a>
          <a href="#workflow" class="transition hover:text-zinc-100">Workflow</a>
          <a href="#deploy" class="transition hover:text-zinc-100">Deploy</a>
        </div>
      </div>
    </footer>
  </div>
</template>
