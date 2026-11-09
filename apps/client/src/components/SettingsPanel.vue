<script setup lang="ts">
import { DEFAULT_SETTINGS, type StreamSettings as TranscriberSettings } from '../audio/streamTranscriber'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'

const dialog = ref<HTMLDialogElement | null>(null)

/** Shown as a modal dialog (gear button in the header); Esc, ✕ or a click outside closes it. */
function open(): void {
  dialog.value?.showModal()
}
function close(): void {
  dialog.value?.close()
}
/** A click on the backdrop lands on the <dialog> itself, not its content. */
function backdropClick(event: MouseEvent): void {
  if (event.target === dialog.value) close()
}
defineExpose({ open })

interface Slider {
  key: keyof TranscriberSettings
  label: string
  help: string
  min: number
  max: number
  step: number
  format: (value: number) => string
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const millis = (ms: number) => `${ms} ms`

const sliders: Slider[] = [
  {
    key: 'pauseMs',
    label: 'Pause that ends a phrase',
    help: 'How long you have to stop talking before the phrase is finished. Longer keeps sentences together across short pauses.',
    min: 300,
    max: 4000,
    step: 100,
    format: seconds,
  },
  {
    key: 'speechThreshold',
    label: 'Speech sensitivity threshold',
    help: 'How sure the voice detector must be that it hears speech. Lower picks up quiet speech; higher ignores more noise.',
    min: 0.1,
    max: 0.95,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'minSpeechMs',
    label: 'Minimum speech',
    help: 'Sounds shorter than this are thrown away (coughs, clicks, a door).',
    min: 0,
    max: 1500,
    step: 50,
    format: millis,
  },
  {
    key: 'preSpeechPadMs',
    label: 'Audio kept before speech',
    help: 'Included from just before speech is detected, so the first syllable isn’t clipped.',
    min: 0,
    max: 1000,
    step: 50,
    format: millis,
  },
  {
    key: 'partialIntervalMs',
    label: 'Live update interval',
    help: 'How often the phrase in progress is re-transcribed. Shorter feels faster but uses more GPU.',
    min: 300,
    max: 3000,
    step: 100,
    format: seconds,
  },
  {
    key: 'speakerThreshold',
    label: 'Voice match threshold',
    help: 'How similar a voice must be to your trained voice to count as you. Higher means fewer strangers tagged as you, but more of your own phrases missed. Watch the Monitor while you and others talk to tune it.',
    min: 0.2,
    max: 0.8,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'bargeInMs',
    label: 'Interrupt sensitivity',
    help: 'How much of your speech Jarvis needs to hear before it pauses. Shorter reacts faster but background noise may pause it; longer is smoother.',
    min: 200,
    max: 1000,
    step: 50,
    format: millis,
  },
  {
    key: 'duckVolume',
    label: 'Volume while unsure',
    help: 'Jarvis turns down to this while it checks whether you are talking, then pauses or comes back up.',
    min: 0.1,
    max: 0.8,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'followUpMs',
    label: 'Jarvis follow-up window',
    help: 'After Jarvis answers, how long it keeps listening to you without needing “Jarvis” again. Say “thanks, Jarvis” or “that’s all” to end the conversation sooner.',
    min: 5000,
    max: 180000,
    step: 5000,
    format: seconds,
  },
  {
    key: 'speakerChangeThreshold',
    label: 'Split when the speaker changes',
    help: 'When people take turns without pausing, Jarvis looks for the point where the voice changes and splits the phrase there. Higher splits more readily (catches quicker turns, but may occasionally split one person); lower splits only on clear changes. 0 turns it off.',
    min: 0,
    max: 0.6,
    step: 0.05,
    format: (v) => (v === 0 ? 'off' : v.toFixed(2)),
  },
  {
    key: 'maxPhraseMs',
    label: 'Maximum phrase length',
    help: 'A phrase is split here even if you never pause.',
    min: 5000,
    max: 28000,
    step: 1000,
    format: seconds,
  },
]

const isDefault = (key: keyof TranscriberSettings) => settings[key] === DEFAULT_SETTINGS[key]
</script>

<template>
  <dialog ref="dialog" class="dialog dialog-lg dialog-scrollable" aria-labelledby="settings-title" @click="backdropClick">
    <div class="dialog-header gap-3">
      <h2 id="settings-title" class="dialog-title">Settings</h2>
      <button type="button" class="btn-outline theme-secondary btn-sm ms-auto" @click="resetSettings">Reset to defaults</button>
      <button type="button" class="btn-close ms-0" aria-label="Close" @click="close"></button>
    </div>
    <div class="dialog-body vstack gap-4">
      <div>
        <div class="d-flex align-items-center gap-2">
          <div class="switch">
            <input
              id="setting-speakReplies"
              type="checkbox"
              :checked="settings.speakReplies >= 0.5"
              @change="settings.speakReplies = ($event.target as HTMLInputElement).checked ? 1 : 0"
            />
          </div>
          <label for="setting-speakReplies">Speak replies</label>
        </div>
        <div class="form-text">Jarvis reads its answers aloud (voice “jarvis”, Qwen3-TTS). Off = text only.</div>
      </div>
      <div>
        <div class="d-flex align-items-center gap-2">
          <div class="switch">
            <input
              id="setting-brain"
              type="checkbox"
              :checked="settings.brain >= 0.5"
              @change="settings.brain = ($event.target as HTMLInputElement).checked ? 1 : 0"
            />
          </div>
          <label for="setting-brain">Use Hermes agent</label>
        </div>
        <div class="form-text">
          Off: Jarvis answers straight from the local LLM (fast). On: requests go to Nous Hermes Agent, which can use
          tools, files and memory (slower). Or say “Jarvis, use Hermes” / “Jarvis, use the local model”. If Hermes isn't
          running, the local model answers.
        </div>
      </div>
      <div>
        <div class="d-flex align-items-center gap-2">
          <div class="switch">
            <input
              id="setting-bargeIn"
              type="checkbox"
              :checked="settings.bargeIn >= 0.5"
              @change="settings.bargeIn = ($event.target as HTMLInputElement).checked ? 1 : 0"
            />
          </div>
          <label for="setting-bargeIn">Interrupt by speaking</label>
        </div>
        <div class="form-text">
          When you start talking, Jarvis turns its volume down; once it's clearly speech, it pauses. Then “stop”,
          “continue” or “repeat” do just that; a new question gets a new answer; anything else and it carries on.
          Needs headphones for now (with speakers it would hear itself).
        </div>
      </div>
      <div v-for="slider in sliders" :key="slider.key">
        <label :for="`setting-${slider.key}`" class="form-label d-flex justify-content-between gap-3 w-100">
          <span>{{ slider.label }}</span>
          <span class="font-monospace" :class="{ 'fw-semibold': !isDefault(slider.key) }">
            {{ slider.format(settings[slider.key]) }}
          </span>
        </label>
        <div class="form-range">
          <input
            :id="`setting-${slider.key}`"
            v-model.number="settings[slider.key]"
            type="range"
            class="form-range-input"
            :min="slider.min"
            :max="slider.max"
            :step="slider.step"
          />
        </div>
        <div class="form-text">{{ slider.help }} Default {{ slider.format(DEFAULT_SETTINGS[slider.key]) }}.</div>
      </div>
      <p class="text-sm fg-3 m-0">Changes apply immediately, even while listening, and are saved in this browser.</p>
    </div>
  </dialog>
</template>

<style scoped>
/* Closed, the dialog takes no space: Bootstrap's dialog styles keep it laid out (hidden), and its tall body stretched the page. */
dialog:not([open]) {
  display: none;
}
</style>
