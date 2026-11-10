<script setup lang="ts">
import { computed } from 'vue'
import { acknowledge, close, notices } from '../notifications'

// What Jarvis's scheduler has to say, over every tab: ringing alarms and
// timers (until stopped or snoozed), and reminders as toasts.

const ringing = computed(() => notices.shown.filter((n) => n.ring))
const toasts = computed(() => notices.shown.filter((n) => !n.ring))
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="notification-stack" aria-live="assertive">
    <div v-for="n in ringing" :key="n.id" class="card notification ringing" role="alertdialog" :aria-label="n.title">
      <div class="card-body vstack gap-2">
        <div class="d-flex align-items-center gap-2">
          <span class="bell" aria-hidden="true">⏰</span>
          <span class="fw-semibold">{{ n.title }}</span>
          <span class="text-sm fg-3 ms-auto">{{ time(n.at) }}</span>
        </div>
        <div>{{ n.text }}</div>
        <div class="d-flex gap-2 flex-wrap">
          <button type="button" class="btn-solid theme-danger" @click="acknowledge(n.id, 'dismiss')">Stop</button>
          <button type="button" class="btn-outline theme-secondary" @click="acknowledge(n.id, 'snooze', 9)">Snooze 9 min</button>
          <button type="button" class="btn-text btn-sm" @click="acknowledge(n.id, 'snooze', 5)">5 min</button>
        </div>
        <span class="text-xs fg-3">Or say “stop” or “snooze”.</span>
      </div>
    </div>
    <div v-for="n in toasts" :key="n.id" class="card notification" role="status">
      <div class="card-body vstack gap-1">
        <div class="d-flex align-items-center gap-2">
          <span class="fw-semibold">{{ n.title }}</span>
          <span v-if="n.late" class="badge theme-warning badge-subtle">while you were away</span>
          <span class="text-sm fg-3 ms-auto">{{ time(n.at) }}</span>
          <button type="button" class="btn-text btn-sm" aria-label="Close" @click="close(n.id)">✕</button>
        </div>
        <div class="notification-text">{{ n.text }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-stack {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(24rem, calc(100vw - 2rem));
  pointer-events: none;
}
.notification {
  pointer-events: auto;
  box-shadow: var(--bs-box-shadow-lg, 0 1rem 3rem rgba(0, 0, 0, 0.3));
  background: var(--bs-bg-body, var(--bs-body-bg, #fff));
}
.notification-text {
  white-space: pre-wrap;
}
.ringing {
  border: 2px solid var(--bs-danger, #dc3545);
  animation: pulse 1.6s ease-in-out infinite;
}
.bell {
  font-size: 1.4rem;
  display: inline-block;
  animation: shake 1.6s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    box-shadow: 0 0 0 0.5rem color-mix(in srgb, var(--bs-danger, #dc3545) 25%, transparent);
  }
}
@keyframes shake {
  0%, 30%, 100% { transform: rotate(0); }
  10% { transform: rotate(-15deg); }
  20% { transform: rotate(15deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ringing, .bell { animation: none; }
}
</style>
