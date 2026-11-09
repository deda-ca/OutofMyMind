<script setup lang="ts">
import { reactive } from 'vue'
import { fileUrl, formatSize, kindOf, type FileRef } from '../uploads'
import { openFile, viewable } from '../viewer'

/** Viewable files open in the document viewer; the rest open raw in a new tab. */
function open(event: MouseEvent, file: FileRef): void {
  if (!viewable(file.path) || event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  openFile(file.path)
}

// Files in the transcript: images as thumbnails, audio and video playable,
// everything else as a chip that opens the file. The path shows where it was
// saved in the workspace (and where to tell Jarvis to move it from).

defineProps<{ files: FileRef[] }>()

/** Files no longer at their path (e.g. Jarvis moved them where you asked): say so instead of a broken preview. */
const gone = reactive<Record<string, boolean>>({})

const ICONS = { image: '🖼️', audio: '🎵', video: '🎬', pdf: '📕', text: '📄', other: '📎' } as const
</script>

<template>
  <span class="d-flex flex-wrap gap-2">
    <span v-for="f in files" :key="f.path" class="file-chip vstack gap-1">
      <span v-if="gone[f.path]" class="text-sm fg-3 fst-italic">No longer here: moved or deleted.</span>
      <a v-else-if="kindOf(f) === 'image'" :href="fileUrl(f)" target="_blank" rel="noopener" :title="`Open ${f.name}`" @click="open($event, f)">
        <img :src="fileUrl(f)" :alt="f.name" class="thumb" loading="lazy" @error="gone[f.path] = true" />
      </a>
      <audio v-else-if="kindOf(f) === 'audio'" :src="fileUrl(f)" controls preload="none" class="media" @error="gone[f.path] = true"></audio>
      <video v-else-if="kindOf(f) === 'video'" :src="fileUrl(f)" controls preload="metadata" class="media video" @error="gone[f.path] = true"></video>
      <a :href="fileUrl(f)" target="_blank" rel="noopener" class="text-sm text-decoration-none name" :title="`workspace/${f.path}`" @click="open($event, f)">
        {{ ICONS[kindOf(f)] }} {{ f.name }} <span class="fg-3">· {{ formatSize(f.size) }}</span>
      </a>
      <code class="text-sm fg-3 path text-truncate" :title="`workspace/${f.path}`">{{ f.path }}</code>
    </span>
  </span>
</template>

<style scoped>
.file-chip {
  max-width: 18rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--bs-border-color, rgba(127, 127, 127, 0.3));
  border-radius: var(--bs-border-radius, 0.375rem);
}
.thumb {
  display: block;
  max-width: 100%;
  max-height: 10rem;
  border-radius: 0.25rem;
  object-fit: contain;
}
.media {
  width: 17rem;
  max-width: 100%;
}
.video {
  max-height: 10rem;
}
.name {
  word-break: break-word;
}
.path {
  font-size: 0.75rem;
}
</style>
