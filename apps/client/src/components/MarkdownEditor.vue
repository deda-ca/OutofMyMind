<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// The Markdown source of a file, edited as text (CodeMirror): what's typed is
// exactly what's saved. Headings, emphasis, links and code are styled in place,
// Enter continues a list or quote, Tab indents, Ctrl+F searches.

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

// Colours come from the page (Bootstrap's variables), so it follows light and dark.
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--bs-link-color, #0d6efd)' },
  { tag: tags.monospace, fontFamily: 'var(--bs-font-monospace, monospace)', fontSize: '0.92em' },
  { tag: tags.quote, fontStyle: 'italic', color: 'var(--bs-secondary-color, inherit)' },
  // The Markdown punctuation itself (#, **, -, [ ]): there, but quieter than the words.
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--bs-secondary-color, #6c757d)' },
  // Code inside fenced blocks.
  { tag: tags.keyword, color: 'var(--bs-purple, #6f42c1)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--bs-success, #198754)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--bs-orange, #fd7e14)' },
  { tag: tags.comment, color: 'var(--bs-secondary-color, #6c757d)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--bs-primary, #0d6efd)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'inherit', fontSize: '0.95rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--bs-font-monospace, ui-monospace, monospace)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '0.25rem 0', caretColor: 'currentColor' },
  '.cm-line': { padding: '0 0.25rem' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
  '.cm-activeLine': { backgroundColor: 'rgba(127, 127, 127, 0.07)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(13, 110, 253, 0.25) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255, 193, 7, 0.25)' },
  '.cm-panels': { backgroundColor: 'var(--bs-tertiary-bg, #f8f9fa)', color: 'inherit' },
  '.cm-panels input, .cm-panels button': { fontSize: '0.85rem' },
})

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(markdownStyle),
        theme,
        // Ctrl+S is the viewer's (it saves from anywhere in it).
        keymap.of([
          indentWithTab,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        }),
      ],
    }),
  })
})

// A new file loaded, or edits discarded: show that text (not on our own typing, which already matches).
watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: 0 } })
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

defineExpose({ focus: () => view?.focus() })
</script>

<template>
  <div ref="host" class="md-editor"></div>
</template>

<style scoped>
.md-editor {
  height: 100%;
  min-height: 0;
}
</style>
