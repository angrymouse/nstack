<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import {
  PhArrowRight,
  PhBracketsCurly,
  PhBookOpen,
  PhCheckCircle,
  PhCloudArrowUp,
  PhCode,
  PhCopy,
  PhDiscordLogo,
  PhFileCode,
  PhFolderSimple,
  PhGitBranch,
  PhPlay,
  PhTerminalWindow,
} from "@phosphor-icons/vue";
import InspiraButton from "~/components/inspira/ui/button/InspiraButton.vue";
import InspiraSurface from "~/components/inspira/ui/surface/InspiraSurface.vue";

const installCommand =
  "curl -fsSL https://nstack.tech/install.sh | bash";
const discordInvite = "https://discord.gg/zHAJ4Ym5TP";
const gitRepoUrl = "https://git.nik.technology/angrymouse/nstack";
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

const foundations = [
  {
    name: "Encore.ts",
    logo: "/assets/logos/encore.svg",
  },
  {
    name: "Nuxt",
    logo: "/assets/logos/nuxt.svg",
  },
  {
    name: "Dokploy",
    logo: "/assets/logos/dokploy.svg",
  },
];

const workflow = [
  {
    icon: PhTerminalWindow,
    title: "Three-command start",
    body: "Install nstack, create an app, and let the CLI run local services, rebuild the client, and prepare deploy files.",
  },
  {
    icon: PhBracketsCurly,
    title: "Encore-shaped backend",
    body: "APIs, databases, caches, Pub/Sub, and object storage live in source, so the architecture stays visible as the app grows.",
  },
  {
    icon: PhCode,
    title: "Agent-ready frontend",
    body: "The typed Encore client is rebuilt as APIs change, so Nuxt screens stay in sync while agents work.",
  },
  {
    icon: PhCloudArrowUp,
    title: "Dokploy provisioning",
    body: "nstack turns the project shape into Dokploy services, routes, domains, resources, and deploy files.",
  },
];

const deployChecks = [
  "Encore resources are discovered from source",
  "Needed Dokploy resources are provisioned from the app shape",
  "Typed clients rebuild before local runs, builds, and deploys",
  "nstack owns the build and deploy handoff for each target",
];

const resourceRows = [
  {
    name: "SQL databases",
    detail: "Encore SQL databases map to Dokploy Postgres resources.",
  },
  {
    name: "Caches",
    detail: "Encore caches map to Dragonfly services.",
  },
  {
    name: "Pub/Sub",
    detail: "Topics and subscriptions map to NSQ-backed services for the deployed app.",
  },
  {
    name: "Object storage",
    detail: "Encore buckets map to RustFS buckets.",
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

type CodeTone =
  | "attribute"
  | "base"
  | "boolean"
  | "comment"
  | "function"
  | "keyword"
  | "muted"
  | "number"
  | "operator"
  | "punctuation"
  | "property"
  | "string"
  | "tag"
  | "type";

type CodeToken = {
  text: string;
  tone?: CodeTone;
};

type CodeFile = {
  path: string;
  label: string;
  language: string;
  source: string;
};

type ProjectRow =
  | {
      type: "folder";
      label: string;
      level: 0 | 1 | 2 | 3;
    }
  | {
      type: "file";
      path: string;
      label: string;
      level: 0 | 1 | 2 | 3;
    };

const codeToneClasses: Record<CodeTone, string> = {
  attribute: "text-cyan-200",
  base: "text-zinc-300",
  boolean: "text-orange-200",
  comment: "text-zinc-600",
  function: "text-yellow-100",
  keyword: "text-sky-200",
  muted: "text-zinc-600",
  number: "text-orange-200",
  operator: "text-zinc-500",
  punctuation: "text-zinc-500",
  property: "text-blue-200",
  string: "text-emerald-200",
  tag: "text-rose-200",
  type: "text-teal-200",
};

const projectIndentClasses: Record<0 | 1 | 2 | 3, string> = {
  0: "pl-2",
  1: "pl-6",
  2: "pl-10",
  3: "pl-14",
};

const projectRows: ProjectRow[] = [
  { type: "folder", label: "my-app", level: 0 },
  { type: "folder", label: "backend/", level: 1 },
  { type: "folder", label: "api/", level: 2 },
  { type: "file", label: "status.ts", path: "backend/api/status.ts", level: 3 },
  { type: "file", label: "db.ts", path: "backend/api/db.ts", level: 3 },
  { type: "file", label: "gateway.ts", path: "backend/api/gateway.ts", level: 3 },
  { type: "file", label: "encore.app", path: "backend/encore.app", level: 2 },
  { type: "folder", label: "frontend/", level: 1 },
  { type: "folder", label: "app/", level: 2 },
  {
    type: "file",
    label: "pages/index.vue",
    path: "frontend/app/pages/index.vue",
    level: 3,
  },
  {
    type: "file",
    label: "utils/api.ts",
    path: "frontend/app/utils/api.ts",
    level: 3,
  },
  { type: "file", label: "nuxt.config.ts", path: "frontend/nuxt.config.ts", level: 2 },
  { type: "file", label: "nstack.config.mjs", path: "nstack.config.mjs", level: 1 },
  { type: "file", label: "pnpm-workspace.yaml", path: "pnpm-workspace.yaml", level: 1 },
  { type: "file", label: "package.json", path: "package.json", level: 1 },
];

const codeFiles: CodeFile[] = [
  {
    path: "backend/api/status.ts",
    label: "status.ts",
    language: "TypeScript",
    source: `import { api } from "encore.dev/api";
import { db } from "./db";

interface StatusResponse {
  app: string;
  commit: string;
  database_ok: boolean;
  uptime_seconds: number;
}

export const ready = api(
  { expose: true, method: "GET", path: "/ready" },
  async () => ({ ok: true }),
);

export const status = api(
  { expose: true, method: "GET", path: "/status" },
  async (): Promise<StatusResponse> => {
    const row = await db.queryRow<{ ok: number }>\`SELECT 1 AS ok\`;
    return {
      app: process.env.APP_ID || "my-app",
      commit: process.env.GIT_COMMIT || "",
      database_ok: row?.ok === 1,
      uptime_seconds: Math.floor(process.uptime()),
    };
  },
);`,
  },
  {
    path: "backend/api/db.ts",
    label: "db.ts",
    language: "TypeScript",
    source: `import { SQLDatabase } from "encore.dev/storage/sqldb";

export const db = new SQLDatabase("app", {
  migrations: "./migrations",
});`,
  },
  {
    path: "backend/api/gateway.ts",
    label: "gateway.ts",
    language: "TypeScript",
    source: `import { Gateway } from "encore.dev/api";

export const gateway = new Gateway({});`,
  },
  {
    path: "backend/encore.app",
    label: "encore.app",
    language: "JSON",
    source: `{
  "id": "my-app"
}`,
  },
  {
    path: "frontend/app/pages/index.vue",
    label: "pages/index.vue",
    language: "Vue",
    source: `<script setup lang="ts">
const { data, error } = await useAsyncData("status", () =>
  apiClient().api.status(),
);
</scr${"ipt"}>

<template>
  <main>
    <h1>my-app</h1>
    <p v-if="error">API unavailable: {{ error.message }}</p>
    <dl v-else-if="data">
      <dt>App</dt>
      <dd>{{ data.app }}</dd>
      <dt>Database</dt>
      <dd>{{ data.database_ok ? "ok" : "not ready" }}</dd>
    </dl>
  </main>
</template>`,
  },
  {
    path: "frontend/app/utils/api.ts",
    label: "utils/api.ts",
    language: "TypeScript",
    source: `import Client, { type ClientOptions } from "../generated/encore-client";

export function apiBaseUrl(): string {
  const config = useRuntimeConfig();
  if (import.meta.server) {
    const backendHost = process.env.NSTACK_BACKEND_HOST || "backend";
    return config.apiServerBaseUrl || \`http://\${backendHost}:8080\`;
  }
  return config.public.apiBaseUrl || "/api";
}

export function apiClient(options: ClientOptions = {}): Client {
  return new Client(apiBaseUrl(), options);
}`,
  },
  {
    path: "frontend/nuxt.config.ts",
    label: "nuxt.config.ts",
    language: "TypeScript",
    source: `export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  runtimeConfig: {
    apiServerBaseUrl: "",
    public: {
      apiBaseUrl: "/api",
    },
  },
});`,
  },
  {
    path: "nstack.config.mjs",
    label: "nstack.config.mjs",
    language: "JavaScript",
    source: `export default {
  app: {
    name: "My App",
    slug: "my-app",
  },
  paths: {
    frontendContext: ".",
  },
  verify: {
    endpoints: [
      { name: "ready", path: "/api/ready", expectStatus: 200 },
    ],
  },
};`,
  },
  {
    path: "pnpm-workspace.yaml",
    label: "pnpm-workspace.yaml",
    language: "YAML",
    source: `packages:
  - backend
  - frontend`,
  },
  {
    path: "package.json",
    label: "package.json",
    language: "JSON",
    source: `{
  "name": "my-app",
  "private": true,
  "scripts": {
    "setup": "nstack setup",
    "dev": "nstack dev",
    "build": "nstack client gen && pnpm --dir frontend build",
    "deploy": "nstack deploy",
    "status": "nstack status"
  },
  "packageManager": "pnpm@10.18.3"
}`,
  },
];

const jsKeywords = new Set([
  "async",
  "await",
  "const",
  "default",
  "export",
  "from",
  "function",
  "import",
  "interface",
  "return",
  "type",
]);

const typeKeywords = new Set(["boolean", "number", "string", "void"]);
const literalKeywords = new Set(["false", "null", "true", "undefined"]);

const pushToken = (tokens: CodeToken[], text: string, tone?: CodeTone) => {
  if (text.length > 0) tokens.push({ text, tone });
};

const highlightYamlLine = (line: string): CodeToken[] => {
  const tokens: CodeToken[] = [];
  const match = line.match(/^(\s*)([A-Za-z0-9_-]+)(:)(.*)$/);
  if (!match) {
    pushToken(tokens, line, line.trim().startsWith("-") ? "string" : "base");
    return tokens;
  }

  pushToken(tokens, match[1]);
  pushToken(tokens, match[2], "property");
  pushToken(tokens, match[3], "punctuation");
  if (match[4]) pushToken(tokens, match[4], "string");
  return tokens;
};

const highlightJsonLine = (line: string): CodeToken[] => {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const stringMatch = rest.match(/^"([^"\\]|\\.)*"/);
    const numberMatch = rest.match(/^-?\d+(\.\d+)?/);
    const wordMatch = rest.match(/^[A-Za-z]+/);
    const whitespaceMatch = rest.match(/^\s+/);

    if (whitespaceMatch) {
      pushToken(tokens, whitespaceMatch[0]);
      index += whitespaceMatch[0].length;
    } else if (stringMatch) {
      const after = line.slice(index + stringMatch[0].length).trimStart();
      pushToken(tokens, stringMatch[0], after.startsWith(":") ? "property" : "string");
      index += stringMatch[0].length;
    } else if (numberMatch) {
      pushToken(tokens, numberMatch[0], "number");
      index += numberMatch[0].length;
    } else if (wordMatch) {
      pushToken(tokens, wordMatch[0], literalKeywords.has(wordMatch[0]) ? "boolean" : "base");
      index += wordMatch[0].length;
    } else {
      pushToken(tokens, rest[0], /[{}[\],:]/.test(rest[0]) ? "punctuation" : "base");
      index += 1;
    }
  }

  return tokens;
};

const highlightCodeLine = (line: string): CodeToken[] => {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const whitespaceMatch = rest.match(/^\s+/);
    const commentMatch = rest.match(/^\/\/.*/);
    const stringMatch = rest.match(/^(`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/);
    const numberMatch = rest.match(/^\d+(\.\d+)?/);
    const tagMatch = rest.match(/^<\/?[A-Za-z][A-Za-z0-9-]*/);
    const identifierMatch = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    const operatorMatch = rest.match(/^(=>|\?\?|\?\.|===|!==|<=|>=|[=:+*/%<>?-])/);

    if (whitespaceMatch) {
      pushToken(tokens, whitespaceMatch[0]);
      index += whitespaceMatch[0].length;
    } else if (commentMatch) {
      pushToken(tokens, commentMatch[0], "comment");
      break;
    } else if (stringMatch) {
      pushToken(tokens, stringMatch[0], "string");
      index += stringMatch[0].length;
    } else if (numberMatch) {
      pushToken(tokens, numberMatch[0], "number");
      index += numberMatch[0].length;
    } else if (tagMatch) {
      const marker = tagMatch[0].startsWith("</") ? "</" : "<";
      const name = tagMatch[0].slice(marker.length);
      pushToken(tokens, marker, "punctuation");
      pushToken(tokens, name, "tag");
      index += tagMatch[0].length;
    } else if (identifierMatch) {
      const word = identifierMatch[0];
      const previous = line.slice(0, index).trimEnd().at(-1);
      const next = line.slice(index + word.length).trimStart().at(0);
      let tone: CodeTone | undefined;

      if (jsKeywords.has(word)) tone = "keyword";
      else if (typeKeywords.has(word)) tone = "type";
      else if (literalKeywords.has(word)) tone = "boolean";
      else if (previous === "." || next === ":") tone = "property";
      else if (next === "(") tone = "function";
      else if (/^[A-Z]/.test(word)) tone = "type";
      else if (previous === "<" || previous === "/") tone = "tag";

      pushToken(tokens, word, tone);
      index += word.length;
    } else if (operatorMatch) {
      pushToken(tokens, operatorMatch[0], "operator");
      index += operatorMatch[0].length;
    } else {
      const char = rest[0];
      pushToken(tokens, char, /[{}[\](),.;]/.test(char) ? "punctuation" : "base");
      index += 1;
    }
  }

  return tokens;
};

const highlightSource = (file: CodeFile): CodeToken[][] => {
  const lines = file.source.split("\n");
  if (file.language === "YAML") return lines.map(highlightYamlLine);
  if (file.language === "JSON") return lines.map(highlightJsonLine);
  return lines.map(highlightCodeLine);
};

const selectedCodePath = ref(codeFiles[0].path);

const selectCodeFile = (path: string) => {
  selectedCodePath.value = path;
};

const selectedCodeFile = computed(
  () =>
    codeFiles.find((file) => file.path === selectedCodePath.value) ??
    codeFiles[0],
);

const selectedCodeLines = computed(() => highlightSource(selectedCodeFile.value));

const runtimeConfig = useRuntimeConfig();
const siteUrl = String(
  runtimeConfig.public.siteUrl || "https://nstack.tech",
).replace(/\/$/, "");
const pageTitle = "nstack | Deployment and provisioning for Encore, Nuxt, and Dokploy";
const pageDescription =
  "nstack creates Encore plus Nuxt apps, provisions Dokploy resources, syncs the typed client, runs local dev, and owns the deploy pipeline.";
const pageImage = `${siteUrl}/assets/og-image.png`;

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogSiteName: "nstack",
  ogType: "website",
  ogUrl: siteUrl,
  ogImage: pageImage,
  ogImageAlt: "nstack landing page with command setup and project file preview",
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
      href: siteUrl,
    },
  ],
  script: [
    {
      type: "application/ld+json",
      textContent: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "nstack",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Linux, macOS, Windows",
        description: pageDescription,
        url: siteUrl,
        image: pageImage,
        softwareRequirements: "Node.js 22 or newer",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
      }),
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

    <header class="fixed inset-x-0 top-0 z-40 px-5 md:px-8">
      <nav
        class="nav-bulb mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-5"
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
          <a
            href="/docs"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Docs
          </a>
          <a
            :href="gitRepoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
          >
            Git
          </a>
        </div>

        <InspiraButton as="a" href="#install" size="sm" variant="secondary">
          Install
        </InspiraButton>
      </nav>
    </header>

    <main id="main">
      <section class="hero-section">
        <div class="hero-grid mx-auto flex max-w-6xl flex-col items-center px-5 pb-12 pt-28 text-center md:px-8 md:pb-16 md:pt-28">
          <div class="mx-auto flex max-w-6xl flex-col items-center">
            <div class="hero-brand-lockup mb-5 grid place-items-center text-zinc-50">
              <span class="hero-logo-frame" aria-hidden="true">
                <img src="/assets/nstack-logo.png" alt="" class="size-10 object-contain">
              </span>
            </div>

            <h1 class="mx-auto max-w-[64rem] text-balance font-display text-5xl font-extrabold leading-tight tracking-tight text-zinc-50 sm:text-6xl md:text-6xl">
              Develop scalable, opinionated, <span class="pastel-text">AI-hardened</span> full stack apps.
            </h1>
            <p class="mx-auto mt-6 max-w-2xl text-pretty text-[19px] font-semibold leading-8 text-zinc-300 md:text-[21px]">
              nstack is the deployment and provisioning tool for Encore + Nuxt
              apps on Dokploy. Create the app, keep the typed client synced,
              run local dev, provision resources, and ship through one CLI
              pipeline.
            </p>

            <div class="mt-7 flex flex-wrap items-center justify-center gap-3">
              <InspiraButton as="a" href="#install" variant="rainbow" class="pastel-cta">
                <span class="pastel-cta-text">Start in 3 commands</span>
                <PhArrowRight :size="18" weight="bold" class="text-zinc-300" aria-hidden="true" />
              </InspiraButton>
              <InspiraButton as="a" href="/docs" variant="secondary">
                <PhBookOpen :size="18" weight="bold" aria-hidden="true" />
                Read docs
              </InspiraButton>
              <InspiraButton
                as="a"
                :href="discordInvite"
                target="_blank"
                rel="noopener noreferrer"
                variant="quiet"
              >
                <PhDiscordLogo :size="18" weight="bold" aria-hidden="true" />
                Join Discord
              </InspiraButton>
              <InspiraButton
                as="a"
                :href="gitRepoUrl"
                target="_blank"
                rel="noopener noreferrer"
                variant="quiet"
              >
                <PhGitBranch :size="18" weight="bold" aria-hidden="true" />
                View Git repo
              </InspiraButton>
            </div>

            <div class="mt-7 flex flex-col items-center">
              <p class="text-[13px] font-extrabold text-zinc-500">Starts with</p>
              <div class="mt-3 flex flex-wrap justify-center gap-2.5">
                <div
                  v-for="foundation in foundations"
                  :key="foundation.name"
                  class="foundation-logo inline-flex h-12 items-center justify-center px-2.5"
                >
                  <img
                    :src="foundation.logo"
                    :alt="foundation.name"
                    class="foundation-logo-img"
                  >
                </div>
              </div>
            </div>
          </div>

          <InspiraSurface id="install" class="hero-command-panel mx-auto mt-10 w-full max-w-2xl p-4 text-left md:p-5">
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
              declarations, frontend rules, generated client code, and Dokploy
              target config they can inspect.
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
        <InspiraSurface class="overflow-hidden">
          <div class="grid gap-5 border-b border-zinc-800 p-5 md:grid-cols-[0.95fr_1.05fr] md:p-7 md:items-end">
            <div>
              <h2 class="max-w-2xl text-balance font-display text-3xl font-extrabold leading-tight text-zinc-50 md:text-4xl">
                Start from a production-shaped app.
              </h2>
              <p class="mt-4 max-w-2xl text-[17px] font-semibold leading-8 text-zinc-400">
                Pick a file to inspect the Encore API, Nuxt page, generated
                client, API helper, workspace config, and package scripts.
              </p>
            </div>
            <div class="flex items-center justify-start gap-2 md:justify-end">
              <PhGitBranch :size="18" weight="bold" class="text-zinc-500" aria-hidden="true" />
              <code class="font-mono text-[12px] font-semibold text-zinc-500">nstack init my-app</code>
            </div>
          </div>

          <div class="grid lg:grid-cols-[19rem_minmax(0,1fr)]">
            <div
              class="ide-tree max-h-[18rem] overflow-y-auto border-b border-zinc-800 p-3 lg:h-[31.5rem] lg:max-h-none lg:border-b-0 lg:border-r"
              role="tablist"
              aria-label="Generated project files"
            >
              <template v-for="row in projectRows" :key="row.type === 'file' ? row.path : `${row.label}-${row.level}`">
                <div
                  v-if="row.type === 'folder'"
                  class="flex h-9 items-center gap-2 pr-2 text-[13px] font-extrabold leading-none text-zinc-300"
                  :class="projectIndentClasses[row.level]"
                >
                  <PhFolderSimple :size="15" weight="bold" aria-hidden="true" />
                  <span>{{ row.label }}</span>
                </div>
                <button
                  v-else
                  type="button"
                  role="tab"
                  :aria-selected="selectedCodePath === row.path"
                  :aria-controls="`code-panel-${row.path}`"
                  class="code-file-tab squircle-sm flex h-9 w-full items-center gap-2 border pr-2 text-left text-[13px] font-bold leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70 active:translate-y-px"
                  :class="[
                    projectIndentClasses[row.level],
                    selectedCodePath === row.path ? 'code-file-tab-selected' : '',
                  ]"
                  @click="selectCodeFile(row.path)"
                >
                  <PhFileCode :size="15" weight="bold" aria-hidden="true" />
                  <span class="truncate">{{ row.label }}</span>
                </button>
              </template>
            </div>

            <div class="flex min-h-0 min-w-0 flex-col bg-zinc-950">
              <div class="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                <div class="min-w-0">
                  <p class="truncate font-mono text-[12px] font-bold text-zinc-200">
                    {{ selectedCodeFile.path }}
                  </p>
                  <p class="mt-1 text-[11px] font-extrabold text-zinc-600">
                    {{ selectedCodeFile.language }}
                  </p>
                </div>
              </div>
              <pre
                :id="`code-panel-${selectedCodeFile.path}`"
                role="tabpanel"
                class="ide-code-pane h-[28rem] overflow-auto p-0 text-[13px] font-semibold leading-7"
                tabindex="0"
              ><code class="block min-w-max py-4"><span
                v-for="(line, lineIndex) in selectedCodeLines"
                :key="`${selectedCodeFile.path}-${lineIndex}`"
                class="code-line block min-h-7 whitespace-pre pr-6"
              ><span
                class="code-line-number mr-4 inline-block w-10 select-none text-right text-zinc-700"
                aria-hidden="true"
              >{{ lineIndex + 1 }}</span><span
                v-for="(token, tokenIndex) in line"
                :key="`${selectedCodeFile.path}-${lineIndex}-${tokenIndex}`"
                :class="codeToneClasses[token.tone ?? 'base']"
              >{{ token.text }}</span></span></code></pre>
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
                Provision Dokploy, then ship.
              </h2>
              <p class="mt-5 max-w-2xl text-[18px] font-semibold leading-8 text-zinc-400">
                Run <code class="text-zinc-200">nstack deploy</code> from the
                app directory. The CLI prepares deploy files, provisions needed
                resources in Dokploy, rebuilds the generated client, and runs
                the deployment pipeline for the target you choose.
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

      <section id="provisioning" class="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-20">
        <div class="grid gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:items-start">
          <InspiraSurface class="overflow-hidden">
            <div class="border-b border-zinc-800 p-5 md:p-6">
              <h2 class="font-display text-3xl font-extrabold text-zinc-50 md:text-4xl">
                Resource provisioning
              </h2>
              <p class="mt-3 max-w-2xl text-[17px] font-semibold leading-8 text-zinc-400">
                nstack reads Encore resource declarations and provisions the
                matching Dokploy services for the selected target.
              </p>
            </div>
            <div class="divide-y divide-zinc-800">
              <div
                v-for="row in resourceRows"
                :key="row.name"
                class="grid gap-2 p-5 md:grid-cols-[12rem_1fr] md:p-6"
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

          <InspiraSurface class="p-6 md:p-8">
            <h2 class="font-display text-3xl font-extrabold leading-tight text-zinc-50 md:text-4xl">
              Deploy pipeline
            </h2>
            <p class="mt-5 text-[17px] font-semibold leading-8 text-zinc-400">
              <code class="text-zinc-200">nstack deploy</code> discovers Encore
              resources, renders deploy files, provisions the target in
              Dokploy, rebuilds generated client code, deploys backend and
              frontend services, and verifies the published URL.
            </p>
            <p class="mt-5 text-[17px] font-semibold leading-8 text-zinc-400">
              If Dokploy has a Git provider connected, nstack can use that
              source provider for deploys. Targets let the same app ship to
              production, staging, or another Dokploy environment.
            </p>
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
              Dokploy target is configured, and nstack takes the build and
              deploy handoff from there.
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
        <p>nstack provisions and deploys Encore + Nuxt apps on Dokploy.</p>
        <div class="flex gap-4">
          <a href="#install" class="transition hover:text-zinc-100">Install</a>
          <a href="#workflow" class="transition hover:text-zinc-100">Workflow</a>
          <a href="#deploy" class="transition hover:text-zinc-100">Deploy</a>
          <a href="/docs" class="transition hover:text-zinc-100">Docs</a>
          <a
            :href="gitRepoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="transition hover:text-zinc-100"
          >
            Git
          </a>
          <a
            :href="discordInvite"
            target="_blank"
            rel="noopener noreferrer"
            class="transition hover:text-zinc-100"
          >
            Discord
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>
