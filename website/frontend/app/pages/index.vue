<script setup lang="ts">
const installCommand = "curl -fsSL https://nstack.playground.nik.technology/install.sh | bash";
const repoUrl = "https://git.nik.technology/angrymouse/nstack";

const copied = ref(false);

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
        <h1>nstack</h1>
        <p class="lede">
          Create an Encore + Nuxt app with typed frontend calls, local dev,
          and Dokploy deploys. Encore Cloud is optional.
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
      </aside>
    </section>

    <section id="install" class="install-band">
      <div class="section-heading">
        <h2>Install nstack, then set up each app.</h2>
      </div>
      <div class="install-command">
        <code>{{ installCommand }}</code>
        <button type="button" class="copy-button" @click="copyInstall">
          {{ copied ? "Copied" : "Copy" }}
        </button>
      </div>
      <p class="note">
        The installer links the CLI into <code>~/.local/bin</code>. In a
        generated app, <code>nstack setup</code> installs dependencies, adds the
        Encore CLI if needed, and checks Docker only when local resources need
        it.
      </p>
    </section>

    <section id="workflow" class="workflow-grid" aria-label="nstack workflow">
      <article>
        <h3>Dev server</h3>
        <p>
          <code>nstack dev</code> starts Encore, Nuxt, and client sync. Agents
          can use <code>nstack devexec</code> for one request and exit.
        </p>
      </article>
      <article>
        <h3>Typed API calls</h3>
        <p>
          Nuxt calls Encore through a generated client, so route and parameter
          changes show up in TypeScript.
        </p>
      </article>
      <article>
        <h3>Encore resources</h3>
        <p>
          Use Encore APIs, databases, caches, Pub/Sub, WebSockets, and buckets
          when a feature needs them.
        </p>
      </article>
    </section>

    <section id="deploy" class="deploy-band">
      <div class="deploy-copy">
        <h2>Deploy the current app.</h2>
        <p>
          Run <code>nstack deploy</code> from a generated app, or pass
          <code>--cwd</code> for a monorepo subdirectory. Use targets for
          staging and preview deploys.
        </p>
      </div>
      <div class="deploy-panel" aria-label="Deploy commands">
        <pre><code>$ nstack deploy
$ nstack deploy --cwd apps/web
$ nstack deploy --env staging</code></pre>
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

.workflow-grid article {
  border: 1px solid rgba(23, 23, 23, 0.18);
  border-radius: 8px;
  background: #ffffff;
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

.deploy-panel {
  border: 1px solid #171717;
  border-radius: 8px;
  background: #111111;
  box-shadow: 10px 10px 0 #d8f14f;
  overflow: hidden;
}

.deploy-panel pre {
  color: #e8f7ef;
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

}

@media (max-width: 560px) {
  .install-command {
    grid-template-columns: 1fr;
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
