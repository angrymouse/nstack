<script setup lang="ts">
import { computed } from "vue";
import type { HTMLAttributes } from "vue";
import { cn } from "@inspira-ui/plugins";

const props = withDefaults(
  defineProps<{
    as?: "a" | "button";
    variant?: "primary" | "secondary" | "quiet" | "rainbow";
    size?: "md" | "sm";
    class?: HTMLAttributes["class"];
  }>(),
  {
    as: "button",
    variant: "primary",
    size: "md",
  },
);

const variants = {
  primary:
    "border-zinc-100 bg-zinc-100 text-zinc-950 hover:bg-white active:bg-zinc-200",
  secondary:
    "border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800 active:bg-zinc-800",
  quiet:
    "border-transparent bg-transparent text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50 active:bg-zinc-800",
  rainbow:
    "border-amber-100/35 bg-zinc-950/80 text-zinc-50 hover:border-rose-200/55 hover:bg-zinc-900/90 active:bg-zinc-950",
};

const sizes = {
  md: "h-11 px-5 text-[15px]",
  sm: "h-9 px-3.5 text-[14px]",
};

const classes = computed(() =>
  cn(
    "squircle-sm inline-flex items-center justify-center gap-2 border font-sans font-extrabold leading-none tracking-normal transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
    variants[props.variant],
    sizes[props.size],
    props.class,
  ),
);
</script>

<template>
  <component :is="props.as" :class="classes">
    <slot />
  </component>
</template>
