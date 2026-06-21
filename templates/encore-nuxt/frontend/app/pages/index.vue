<script setup lang="ts">
const { data, error } = await useAsyncData("status", () => apiClient().api.status());
</script>

<template>
  <main>
    <h1>__APP_NAME__</h1>
    <p v-if="error">API unavailable: {{ error.message }}</p>
    <dl v-else-if="data">
      <dt>App</dt>
      <dd>{{ data.app }}</dd>
      <dt>Commit</dt>
      <dd>{{ data.commit || "local" }}</dd>
      <dt>Database</dt>
      <dd>{{ data.database_ok ? "ok" : "not ready" }}</dd>
      <dt>Uptime</dt>
      <dd>{{ data.uptime_seconds }}s</dd>
    </dl>
  </main>
</template>
