<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'

// A reply from Jarvis, formatted (headings, lists, bold, code, tables, links),
// sized to sit in the transcript rather than read like a document.

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html: sanitized with DOMPurify (markdown.ts) -->
  <div class="md" v-html="html"></div>
</template>

<style scoped>
.md {
  min-width: 0;
  overflow-wrap: anywhere;
}
.md :deep(> :first-child) {
  margin-top: 0;
}
.md :deep(> :last-child) {
  margin-bottom: 0;
}
.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(blockquote),
.md :deep(pre),
.md :deep(table) {
  margin-block: 0 0.6em;
}
.md :deep(ul),
.md :deep(ol) {
  padding-inline-start: 1.4em;
}
.md :deep(li > ul),
.md :deep(li > ol),
.md :deep(li > p) {
  margin-bottom: 0;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin-block: 0.8em 0.35em;
  font-size: 1.05em;
  font-weight: 650;
  line-height: 1.3;
  color: inherit;
}
.md :deep(h1) {
  font-size: 1.2em;
}
.md :deep(h2) {
  font-size: 1.12em;
}
.md :deep(a) {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
.md :deep(code) {
  padding: 0.1em 0.35em;
  border-radius: 0.25rem;
  font-size: 0.88em;
  background: color-mix(in oklab, currentColor 10%, transparent);
}
.md :deep(pre) {
  padding: 0.6rem 0.8rem;
  border-radius: 0.375rem;
  overflow-x: auto;
  font-size: 0.85em;
  background: color-mix(in oklab, currentColor 8%, transparent);
}
.md :deep(pre code) {
  padding: 0;
  background: none;
  font-size: inherit;
}
.md :deep(blockquote) {
  padding-inline-start: 0.8em;
  border-inline-start: 3px solid color-mix(in oklab, currentColor 30%, transparent);
  opacity: 0.9;
}
.md :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.92em;
}
.md :deep(th),
.md :deep(td) {
  padding: 0.25em 0.6em;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  text-align: start;
}
.md :deep(hr) {
  margin-block: 0.8em;
  opacity: 0.3;
}
.md :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
