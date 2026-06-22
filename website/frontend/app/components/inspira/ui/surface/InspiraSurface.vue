<script setup lang="ts">
import { computed } from "vue";
import type { HTMLAttributes } from "vue";
import { cn } from "@inspira-ui/plugins";

const props = withDefaults(
  defineProps<{
    as?: "div" | "section" | "article" | "aside";
    tone?: "solid" | "soft" | "flat";
    class?: HTMLAttributes["class"];
  }>(),
  {
    as: "div",
    tone: "solid",
  },
);

const tones = {
  solid:
    "border-zinc-800 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.32)]",
  soft:
    "border-zinc-800 bg-zinc-900 shadow-[0_18px_52px_rgba(0,0,0,0.24)]",
  flat: "border-zinc-800/80 bg-zinc-950",
};

const classes = computed(() =>
  cn(
    "squircle-xl relative overflow-hidden border text-zinc-100",
    tones[props.tone],
    props.class,
  ),
);
</script>

<template>
  <component :is="props.as" :class="classes">
    <slot />
  </component>
</template>
