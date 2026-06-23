<script setup lang="ts">
import { computed } from "vue";
import { PhArrowLeft, PhDiscordLogo, PhGitBranch } from "@phosphor-icons/vue";
import InspiraButton from "~/components/inspira/ui/button/InspiraButton.vue";

type NavigationItem = {
  title: string;
  path: string;
  children?: NavigationItem[];
};

type TocLink = {
  id: string;
  text: string;
  depth: number;
  children?: TocLink[];
};

const discordInvite = "https://discord.gg/zHAJ4Ym5TP";
const gitRepoUrl = "https://git.nik.technology/angrymouse/nstack";
const runtimeConfig = useRuntimeConfig();
const route = useRoute();
const siteUrl = String(
  runtimeConfig.public.siteUrl || "https://nstack.tech",
).replace(/\/$/, "");

const currentPath = computed(() => {
  const slug = route.params.slug;
  const parts = (Array.isArray(slug) ? slug : slug ? [String(slug)] : []).map((part) => String(part).trim()).filter(Boolean);
  if (parts[parts.length - 1] === "index") {
    parts.pop();
  }
  return `/docs${parts.length > 0 ? `/${parts.join("/")}` : ""}`;
});

const { data: page } = await useAsyncData(
  "docs-page",
  async () => {
    const primary = await queryCollection("content").path(currentPath.value).first();
    if (primary) return primary;
    if (currentPath.value === "/docs") {
      return queryCollection("content").path("/docs/index").first();
    }
    return null;
  },
  {
    watch: [currentPath],
  },
);

if (!page.value) {
  throw createError({
    statusCode: 404,
    statusMessage: "Docs page not found",
  });
}

const { data: navigation } = await useAsyncData("docs-navigation", () =>
  queryCollectionNavigation("content").where("path", "LIKE", "/docs%"),
);

const docsOrder = [
  "/docs",
  "/docs/getting-started",
  "/docs/local-development",
  "/docs/deployment",
  "/docs/commands",
];

const docsOrderIndex = (path: string) => {
  const index = docsOrder.indexOf(path);
  return index === -1 ? docsOrder.length : index;
};

const docsNavigation = computed<NavigationItem[]>(() => {
  const items = (navigation.value ?? []) as NavigationItem[];
  const docsRoot = items.find((item) => item.path === "/docs");
  const docsItems = docsRoot?.children?.length
    ? docsRoot.children
    : items.filter((item) => item.path.startsWith("/docs"));

  return [...docsItems].sort((a, b) => docsOrderIndex(a.path) - docsOrderIndex(b.path));
});

const tocLinks = computed<TocLink[]>(() => {
  const body = page.value?.body as { toc?: { links?: TocLink[] } } | undefined;
  return body?.toc?.links ?? [];
});

const pageTitle = computed(() => `${page.value?.title ?? "Docs"} | nstack docs`);
const pageDescription = computed(
  () =>
    page.value?.description ??
    "Docs for running, provisioning, and deploying Encore plus Nuxt apps with nstack.",
);
const pageImage = `${siteUrl}/assets/og-image.png`;

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogSiteName: "nstack",
  ogType: "article",
  ogUrl: () => `${siteUrl}${currentPath.value}`,
  ogImage: pageImage,
  ogImageAlt: "nstack documentation page",
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
      href: () => `${siteUrl}${currentPath.value}`,
    },
  ],
});
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
          <a
            href="/docs"
            class="squircle-sm px-3 py-2 text-[14px] font-bold text-zinc-50 transition hover:bg-zinc-900"
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

        <InspiraButton as="a" href="/#install" size="sm" variant="secondary">
          Install
        </InspiraButton>
      </nav>
    </header>

    <main
      id="docs-main"
      class="grid min-h-dvh gap-8 px-5 pb-20 pt-28 md:px-8 lg:grid-cols-[18rem_minmax(0,1fr)_16rem] lg:gap-0 lg:px-0 lg:pt-24 xl:grid-cols-[19.5rem_minmax(0,1fr)_17rem]"
    >
      <aside
        class="border-zinc-800 lg:sticky lg:top-24 lg:self-start lg:border-r lg:px-5 lg:py-7 xl:px-7"
      >
        <a
          href="/"
          class="squircle-sm inline-flex items-center gap-2 px-2 py-1 text-[14px] font-bold text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-100"
        >
          <PhArrowLeft :size="17" weight="bold" aria-hidden="true" />
          Back home
        </a>

        <nav class="mt-6 grid gap-1" aria-label="Documentation">
          <NuxtLink
            v-for="item in docsNavigation"
            :key="item.path"
            :to="item.path"
            class="docs-sidebar-link"
            :class="currentPath === item.path ? 'docs-sidebar-link-active' : ''"
          >
            {{ item.title }}
          </NuxtLink>
        </nav>

        <div class="mt-6 hidden gap-2 lg:grid">
          <a
            :href="gitRepoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="squircle-sm inline-flex items-center gap-2 border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] font-bold text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-50"
          >
            <PhGitBranch :size="17" weight="bold" aria-hidden="true" />
            Git repo
          </a>
          <a
            :href="discordInvite"
            target="_blank"
            rel="noopener noreferrer"
            class="squircle-sm inline-flex items-center gap-2 border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] font-bold text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-50"
          >
            <PhDiscordLogo :size="17" weight="bold" aria-hidden="true" />
            Discord
          </a>
        </div>
      </aside>

      <article class="min-w-0 px-0 lg:px-12 lg:py-7 xl:px-16 2xl:px-20">
        <ContentRenderer
          v-if="page"
          :value="page"
          class="docs-prose max-w-[62rem]"
        />
      </article>

      <aside
        class="hidden border-l border-zinc-800 px-5 py-7 lg:sticky lg:top-24 lg:block lg:self-start xl:px-7"
      >
        <p class="text-[12px] font-extrabold text-zinc-500">On this page</p>
        <nav v-if="tocLinks.length > 0" class="mt-3 grid gap-2" aria-label="Table of contents">
          <a
            v-for="link in tocLinks"
            :key="link.id"
            :href="`#${link.id}`"
            class="text-[13px] font-bold leading-5 text-zinc-500 transition hover:text-zinc-200"
          >
            {{ link.text }}
          </a>
        </nav>
        <p v-else class="mt-3 text-[13px] font-semibold leading-6 text-zinc-600">
          Section links appear here on longer docs pages.
        </p>
      </aside>
    </main>
  </div>
</template>
