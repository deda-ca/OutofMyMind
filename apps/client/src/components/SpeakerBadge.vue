<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  speaker: { isOwner: boolean | null; similarity: number | null; confidence: string } | null | undefined
  /** An early guess (phrase still in progress), shown lighter. */
  early?: boolean
}>()

const view = computed(() => {
  const s = props.speaker
  if (!s || s.isOwner === null) return null // voice not trained yet: no tag
  const sure = s.confidence === 'high' && !props.early
  if (s.isOwner) return { label: 'You', theme: sure ? 'theme-primary' : 'theme-info', sure }
  return { label: 'Someone else', theme: 'theme-secondary', sure }
})

const title = computed(() => {
  const s = props.speaker
  if (!s) return ''
  const parts = [`Voice similarity to you: ${s.similarity === null ? '–' : s.similarity.toFixed(2)}`, `confidence: ${s.confidence}`]
  if (props.early) parts.push('early guess')
  return parts.join(' · ')
})
</script>

<template>
  <span v-if="view" class="badge" :class="[view.theme, { 'badge-subtle': !view.sure }]" :title="title">
    {{ view.label }}{{ view.sure ? '' : '?' }}
  </span>
</template>
