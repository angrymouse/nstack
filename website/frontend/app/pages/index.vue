<script setup lang="ts">
const installCommand = "curl -fsSL https://nstack.playground.nik.technology/install.sh | bash";
const repoUrl = "https://git.nik.technology/angrymouse/nstack";

const { data: status } = await useAsyncData("status", () => apiClient().api.ready());
const copied = ref(false);

const statusLabel = computed(() => (status.value?.ok ? "online" : "local"));
const commitLabel = computed(() => status.value?.commit || "local");

async function copyInstall() {
  if (!import.meta.client || !navigator.clipboard) return;
  await navigator.clipboard.writeText(installCommand);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1600);
}
</script>

<template>
  <main class="site-shell">
    <nav class="topbar" aria-label="Primary">
      <a class="brand" href="#top" aria-label="nstack home">
        <span class="brand-mark">ns</span>
        <span>nstack</span>
      </a>
      <div class="nav-links">
        <a href="#install">Install</a>
        <a href="#workflow">Workflow</a>
        <a href="#deploy">Deploy</a>
        <a :href="repoUrl">Source</a>
      </div>
    </nav>

    <section id="top" class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Encore + Nuxt + Dokploy</p>
        <h1>nstack</h1>
        <p class="lede">
          A generated full-stack app shape with local HMR, Encore client sync,
          Dokploy environments, and source-built deployments that do not require
          Encore Cloud.
        </p>
        <div class="hero-actions" aria-label="Primary actions">
          <a class="button button-primary" href="#install">Install</a>
          <a class="button button-secondary" :href="repoUrl">View source</a>
        </div>
      </div>

      <aside class="hero-visual" aria-label="nstack command preview">
        <div class="terminal">
          <div class="terminal-bar">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <pre><code>$ {{ installCommand }}
$ nstack init my-app
$ cd my-app
$ nstack setup
$ nstack devexec "await apiJson('/status')"
$ nstack deploy</code></pre>
        </div>
        <dl class="runtime-strip">
          <div>
            <dt>Status</dt>
            <dd>{{ statusLabel }}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>{{ commitLabel }}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>Dokploy</dd>
          </div>
        </dl>
      </aside>
    </section>

    <section id="install" class="install-band">
      <div class="section-heading">
        <p class="eyebrow">Fresh machine path</p>
        <h2>Install once, then let setup fill the gaps.</h2>
      </div>
      <div class="install-command">
        <code>{{ installCommand }}</code>
        <button type="button" class="copy-button" @click="copyInstall">
          {{ copied ? "Copied" : "Copy" }}
        </button>
      </div>
      <p class="note">
        The installer creates a user-owned checkout, activates pnpm with
        Corepack when needed, and links the CLI into <code>~/.local/bin</code>.
        Generated apps use <code>nstack setup</code> to install dependencies,
        bootstrap pnpm and Encore CLI, and check Docker only when declared
        resources need it.
      </p>
    </section>

    <section id="workflow" class="workflow-grid" aria-label="nstack workflow">
      <article>
        <span class="kicker">01</span>
        <h3>Local dev</h3>
        <p>
          One command runs Encore, Nuxt, and generated-client watching. AI
          harnesses use <code>nstack devexec</code> for one-shot checks instead
          of leaving dev servers behind.
        </p>
      </article>
      <article>
        <span class="kicker">02</span>
        <h3>Typed frontend API</h3>
        <p>
          The Encore client is generated from local metadata and patched for
          nstack/Dokploy targets, so the frontend does not depend on Encore
          Cloud environments.
        </p>
      </article>
      <article>
        <span class="kicker">03</span>
        <h3>Proper resources</h3>
        <p>
          New features are expected to use idiomatic Encore and Nuxt
          abstractions: APIs, generated clients, databases, caches, Pub/Sub,
          WebSockets, and other resources where they fit.
        </p>
      </article>
    </section>

    <section id="deploy" class="deploy-band">
      <div class="deploy-copy">
        <p class="eyebrow">Dokploy-first</p>
        <h2>Production, staging, and previews use nstack targets.</h2>
        <p>
          The website itself is configured for
          <strong>nstack.playground.nik.technology</strong>. Source deployment
          reads the generated Compose file from this repository and builds from
          the website app directory.
        </p>
      </div>
      <div class="deploy-map" aria-label="Deployment map">
        <div class="map-node strong">nstack deploy</div>
        <div class="map-line"></div>
        <div class="map-node">render Compose</div>
        <div class="map-line"></div>
        <div class="map-node">push source</div>
        <div class="map-line"></div>
        <div class="map-node strong">Dokploy</div>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(html) {
  scroll-behavior: smooth;
}

:global(body) {
  margin: 0;
  background: #f5f7f4;
  color: #171717;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

:global(*) {
  box-sizing: border-box;
}

.site-shell {
  min-height: 100vh;
  background:
    linear-gradient(90deg, rgba(23, 23, 23, 0.055) 1px, transparent 1px),
    linear-gradient(0deg, rgba(23, 23, 23, 0.045) 1px, transparent 1px),
    #f5f7f4;
  background-size: 42px 42px;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 68px;
  padding: 0 clamp(18px, 4vw, 56px);
  border-bottom: 1px solid rgba(23, 23, 23, 0.14);
  background: rgba(245, 247, 244, 0.92);
  backdrop-filter: blur(16px);
}

.brand,
.nav-links a {
  color: #171717;
  text-decoration: none;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
}

.brand-mark {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 2px solid #171717;
  background: #d8f14f;
  font-size: 12px;
  line-height: 1;
  text-transform: uppercase;
}

.nav-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 16px;
  font-size: 14px;
  font-weight: 650;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.82fr);
  gap: clamp(28px, 5vw, 72px);
  min-height: min(760px, calc(100svh - 42px));
  padding: clamp(56px, 8vw, 104px) clamp(18px, 4vw, 56px) clamp(44px, 6vw, 76px);
  align-items: center;
  border-bottom: 1px solid rgba(23, 23, 23, 0.16);
}

.hero-copy {
  max-width: 760px;
}

.eyebrow,
.kicker {
  margin: 0 0 14px;
  color: #0b6b4f;
  font-size: 12px;
  font-weight: 850;
  text-transform: uppercase;
  letter-spacing: 0;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 20px;
  font-size: clamp(72px, 12vw, 160px);
  line-height: 0.86;
  letter-spacing: 0;
}

h2 {
  margin-bottom: 18px;
  font-size: clamp(32px, 5vw, 64px);
  line-height: 0.98;
  letter-spacing: 0;
}

h3 {
  margin-bottom: 12px;
  font-size: 24px;
  line-height: 1.05;
  letter-spacing: 0;
}

.lede {
  max-width: 680px;
  color: #343434;
  font-size: clamp(19px, 2vw, 25px);
  line-height: 1.32;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.button,
.copy-button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border: 1px solid #171717;
  border-radius: 6px;
  padding: 0 18px;
  font-weight: 800;
  text-decoration: none;
  cursor: pointer;
}

.button-primary {
  background: #171717;
  color: #ffffff;
}

.button-secondary,
.copy-button {
  background: #ffffff;
  color: #171717;
}

.hero-visual {
  min-width: 0;
}

.terminal {
  overflow: hidden;
  border: 1px solid #171717;
  border-radius: 8px;
  background: #111111;
  box-shadow: 10px 10px 0 #d8f14f;
}

.terminal-bar {
  display: flex;
  gap: 7px;
  padding: 13px 15px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.terminal-bar span {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #ff5a3c;
}

.terminal-bar span:nth-child(2) {
  background: #f8c44f;
}

.terminal-bar span:nth-child(3) {
  background: #31b97a;
}

pre {
  margin: 0;
  overflow-x: auto;
  padding: clamp(18px, 3vw, 28px);
  color: #e8f7ef;
  font-size: clamp(13px, 1.6vw, 16px);
  line-height: 1.65;
}

code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.runtime-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 22px 0 0;
}

.runtime-strip div,
.workflow-grid article {
  border: 1px solid rgba(23, 23, 23, 0.18);
  border-radius: 8px;
  background: #ffffff;
}

.runtime-strip div {
  padding: 13px;
}

.runtime-strip dt {
  color: #686868;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.runtime-strip dd {
  margin: 6px 0 0;
  overflow: hidden;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.install-band,
.deploy-band {
  padding: clamp(44px, 7vw, 88px) clamp(18px, 4vw, 56px);
  border-bottom: 1px solid rgba(23, 23, 23, 0.16);
}

.section-heading {
  max-width: 860px;
}

.install-command {
  display: flex;
  align-items: stretch;
  max-width: 980px;
  border: 1px solid #171717;
  border-radius: 8px;
  background: #ffffff;
}

.install-command code {
  display: block;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding: 18px;
  font-size: clamp(14px, 2vw, 18px);
  line-height: 1.4;
}

.copy-button {
  min-width: 94px;
  min-height: 100%;
  border-width: 0 0 0 1px;
  border-radius: 0 7px 7px 0;
}

.note {
  max-width: 900px;
  margin: 22px 0 0;
  color: #3b3b3b;
  font-size: 17px;
  line-height: 1.55;
}

.workflow-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  padding: clamp(44px, 7vw, 88px) clamp(18px, 4vw, 56px);
  border-bottom: 1px solid rgba(23, 23, 23, 0.16);
}

.workflow-grid article {
  min-height: 250px;
  padding: clamp(20px, 3vw, 32px);
}

.workflow-grid p,
.deploy-copy p {
  color: #3b3b3b;
  font-size: 17px;
  line-height: 1.55;
}

.deploy-band {
  display: grid;
  grid-template-columns: minmax(0, 0.82fr) minmax(320px, 1fr);
  gap: clamp(28px, 5vw, 64px);
  align-items: center;
}

.deploy-copy {
  max-width: 740px;
}

.deploy-map {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px minmax(0, 1fr) 38px minmax(0, 1fr) 38px minmax(0, 1fr);
  align-items: center;
}

.map-node {
  display: grid;
  min-height: 92px;
  place-items: center;
  border: 1px solid #171717;
  border-radius: 8px;
  background: #ffffff;
  padding: 14px;
  text-align: center;
  font-weight: 850;
}

.map-node.strong {
  background: #171717;
  color: #ffffff;
}

.map-line {
  height: 2px;
  background: #b42318;
}

@media (max-width: 900px) {
  .topbar {
    align-items: flex-start;
    flex-direction: column;
    padding-top: 16px;
    padding-bottom: 16px;
  }

  .nav-links {
    justify-content: flex-start;
  }

  .hero,
  .deploy-band {
    grid-template-columns: 1fr;
  }

  .hero {
    min-height: auto;
  }

  .workflow-grid {
    grid-template-columns: 1fr;
  }

  .deploy-map {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .map-line {
    width: 2px;
    height: 26px;
    justify-self: center;
  }
}

@media (max-width: 560px) {
  .runtime-strip,
  .install-command {
    grid-template-columns: 1fr;
  }

  .runtime-strip {
    display: grid;
  }

  .install-command {
    display: block;
  }

  .copy-button {
    width: 100%;
    border-width: 1px 0 0;
    border-radius: 0 0 7px 7px;
  }

  h1 {
    font-size: clamp(64px, 23vw, 112px);
  }
}
</style>
