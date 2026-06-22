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
  PhStack,
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
    icon: PhCode,
    title: "Nuxt frontend",
    body: "Nuxt imports the generated Encore client, so API changes show up as typed calls in the app.",
  },
  {
    icon: PhBracketsCurly,
    title: "Encore backend",
    body: "Define APIs and resources in Encore. nstack keeps the frontend client in sync during local development.",
  },
  {
    icon: PhCloudArrowUp,
    title: "Dokploy deploy",
    body: "Deploy provisions the Dokploy app, routes, domains, and Encore resource wiring from one CLI flow.",
  },
];

const deployChecks = [
  "Encore resources are discovered from source",
  "Dokploy services are rendered into deploy files",
  "Generated clients are synced before build and deploy",
  "Targets can be reused for staging and production",
];

useHead({
  title: "nstack",
  meta: [
    {
      name: "description",
      content:
        "Create Encore and Nuxt apps with generated clients, local orchestration, and Dokploy deployment.",
    },
    {
      property: "og:title",
      content: "nstack",
    },
    {
      property: "og:description",
      content:
        "Create Encore and Nuxt apps with generated clients, local orchestration, and Dokploy deployment.",
    },
  ],
  link: [
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
  <div class="min-h-dvh text-zinc-100">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-zinc-100 focus:px-4 focus:py-3 focus:font-sans focus:font-extrabold focus:text-zinc-950"
    >
      Skip to content
    </a>

    <header class="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950">
      <nav
        class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 md:px-8"
        aria-label="Primary"
      >
        <a href="#main" class="flex items-center gap-3 text-zinc-50">
          <span
            class="grid size-9 place-items-center rounded-lg border border-zinc-700 bg-zinc-900"
            aria-hidden="true"
          >
            <PhStack :size="20" weight="bold" />
          </span>
          <span class="font-display text-[22px] font-extrabold tracking-normal">
            nstack
          </span>
        </a>

        <div class="hidden items-center gap-1 md:flex">
          <a
            href="#workflow"
            class="rounded-md px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Workflow
          </a>
          <a
            href="#deploy"
            class="rounded-md px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Deploy
          </a>
          <a
            href="#commands"
            class="rounded-md px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
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
      <section class="mx-auto grid max-w-6xl gap-10 px-5 pb-16 pt-14 md:px-8 md:pb-24 md:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
        <div>
          <h1 class="max-w-3xl text-balance font-display text-5xl font-extrabold leading-[0.98] tracking-normal text-zinc-50 md:text-7xl">
            Create Encore and Nuxt apps that deploy to Dokploy.
          </h1>
          <p class="mt-6 max-w-2xl text-pretty text-[19px] font-semibold leading-8 text-zinc-300 md:text-[21px]">
            nstack creates the app, keeps the Encore client generated for Nuxt,
            and runs the local stack with one command.
          </p>

          <div class="mt-8 flex flex-col gap-3 sm:flex-row">
            <InspiraButton as="a" href="#install">
              Install nstack
              <PhArrowRight :size="18" weight="bold" aria-hidden="true" />
            </InspiraButton>
            <InspiraButton as="a" href="#workflow" variant="quiet">
              See workflow
            </InspiraButton>
          </div>
        </div>

        <InspiraSurface id="install" class="p-4 md:p-5">
          <div class="flex items-start justify-between gap-5">
            <div>
              <p class="text-[15px] font-extrabold text-zinc-50">Install command</p>
              <p class="mt-1 text-[14px] font-semibold leading-6 text-zinc-400">
                Run this once, then create an app with
                <code class="text-zinc-200">nstack init my-app</code>.
              </p>
            </div>
            <button
              type="button"
              class="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 transition hover:border-zinc-500 hover:text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70 active:translate-y-px"
              :aria-label="copiedInstall ? 'Install command copied' : 'Copy install command'"
              @click="copyInstall"
            >
              <PhCheckCircle v-if="copiedInstall" :size="19" weight="bold" />
              <PhCopy v-else :size="19" weight="bold" />
            </button>
          </div>
          <pre class="mt-5 whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-[13px] leading-6 text-zinc-200"><code>{{ installCommand }}</code></pre>
        </InspiraSurface>
      </section>

      <section id="commands" class="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
        <div class="grid gap-3 md:grid-cols-3">
          <InspiraSurface
            v-for="item in quickStart"
            :key="item.label"
            tone="soft"
            class="p-5"
          >
            <div class="flex items-center gap-3">
              <span class="grid size-10 place-items-center rounded-lg bg-zinc-800 text-zinc-100">
                <component :is="item.icon" :size="21" weight="bold" />
              </span>
              <p class="font-display text-xl font-extrabold text-zinc-50">
                {{ item.label }}
              </p>
            </div>
            <pre class="mt-5 whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 text-[12px] font-semibold leading-5 text-zinc-300"><code>{{ item.command }}</code></pre>
          </InspiraSurface>
        </div>
      </section>

      <section id="workflow" class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <div class="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div class="lg:sticky lg:top-28">
            <h2 class="max-w-xl text-balance font-display text-4xl font-extrabold leading-tight text-zinc-50 md:text-5xl">
              One workflow for local work and deployment.
            </h2>
            <p class="mt-5 max-w-xl text-pretty text-[18px] font-semibold leading-8 text-zinc-400">
              The generated project is a normal Encore and Nuxt app. nstack
              handles the glue code, client generation, and deploy target setup.
            </p>
          </div>

          <div class="space-y-4">
            <InspiraSurface
              v-for="step in workflow"
              :key="step.title"
              tone="flat"
              class="grid gap-5 p-5 md:grid-cols-[3.5rem_1fr] md:p-6"
            >
              <div class="grid size-14 place-items-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100">
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
            <div class="rounded-lg border border-zinc-800 bg-zinc-950">
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
              Start with a real app structure.
            </h2>
            <p class="mt-4 text-[17px] font-semibold leading-8 text-zinc-400">
              The template includes the Encore backend, Nuxt frontend, generated
              client location, local scripts, and deploy files nstack manages.
            </p>

            <div class="mt-7 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <div class="flex items-center gap-2 text-[13px] font-bold text-zinc-500">
                <PhGitBranch :size="17" weight="bold" aria-hidden="true" />
                <span>Generated project</span>
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
            <div class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
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
                Deploy with the same CLI.
              </h2>
              <p class="mt-5 max-w-2xl text-[18px] font-semibold leading-8 text-zinc-400">
                Run <code class="text-zinc-200">nstack deploy</code> from the
                app directory. The CLI prepares the deploy files and applies the
                Dokploy target you choose.
              </p>

              <div class="mt-7 grid gap-3">
                <div
                  v-for="item in deployChecks"
                  :key="item"
                  class="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
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
              Ready command path
            </h2>
            <p class="mt-3 max-w-2xl text-[17px] font-semibold leading-8 text-zinc-400">
              Install nstack, create an app, run it locally, then deploy when
              the Dokploy target is ready.
            </p>
          </div>
          <div class="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-[13px] font-semibold leading-6 text-zinc-300">
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
        <p>nstack creates Encore and Nuxt apps for Dokploy.</p>
        <div class="flex gap-4">
          <a href="#install" class="transition hover:text-zinc-100">Install</a>
          <a href="#workflow" class="transition hover:text-zinc-100">Workflow</a>
          <a href="#deploy" class="transition hover:text-zinc-100">Deploy</a>
        </div>
      </div>
    </footer>
  </div>
</template>
