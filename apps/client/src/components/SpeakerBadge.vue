<script setup lang="ts">
import { computed } from 'vue'

export interface BadgeSpeaker {
  name: string | null
  named?: boolean
  isOwner: boolean | null
  similarity: number | null
  match?: number | null
  confidence: string
}

const props = defineProps<{
  speaker: BadgeSpeaker | null | undefined
  /** An early guess (phrase still in progress), shown lighter. */
  early?: boolean
}>()

const view = computed(() => {
  const s = props.speaker
  if (!s) return null
  // Voice not trained and nobody matched: no tag at all.
  if (s.isOwner === null && !s.name) return null
  const sure = s.confidence === 'high' && !props.early
  const label = s.isOwner ? 'You' : (s.name ?? 'Someone else')
  const theme = s.isOwner ? 'theme-primary' : s.named ? 'theme-success' : 'theme-secondary'
  return { label, theme, sure }
})

const title = computed(() => {
  const s = props.speaker
  if (!s) return ''
  const parts = [`Voice similarity to you: ${s.similarity == null ? '–' : s.similarity.toFixed(2)}`]
  if (s.match != null) parts.push(`match to ${s.name}: ${s.match.toFixed(2)}`)
  parts.push(`confidence: ${s.confidence}`)
  if (props.early) parts.push('early guess')
  return parts.join(' · ')
})
</script>

<template>
  <span v-if="view" class="badge" :class="[view.theme, { 'badge-subtle': !view.sure }]" :title="title">
    {{ view.label }}{{ view.sure ? '' : '?' }}
  </span>
</template>
