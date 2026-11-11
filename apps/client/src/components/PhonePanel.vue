<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { answer, decline, dial, hangUp, joinAudio, leaveAudio, loadPhone, phone, sendDigit, sendText, setMuted, type CallRecord } from '../phone'

// Calls through Jarvis (server: apps/server/src/phone, design: docs/phone.md):
// you talk here (headphones are best), and every call is recorded and
// transcribed into the workspace's calls/ folder, where Jarvis can read it.

const number = ref('')
const textTo = ref('')
const textBody = ref('')
async function send(): Promise<void> {
  if (!textTo.value.trim() || !textBody.value.trim()) return
  if (await sendText(textTo.value, textBody.value)) textBody.value = ''
}
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void loadPhone()
  clock = setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => clearInterval(clock))

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

const lineBadge = computed(() => {
  const s = phone.line.state
  if (s === 'registered') return { text: `Ready${phone.line.number ? `: ${phone.line.number}` : ''}`, theme: 'theme-success badge-subtle' }
  if (s === 'registering') return { text: 'Connecting to VoIP.ms…', theme: 'theme-secondary badge-subtle' }
  if (s === 'failed') return { text: `Not connected: ${phone.line.detail}`, theme: 'theme-danger' }
  return { text: 'Off', theme: 'theme-secondary badge-subtle' }
})

const callTime = computed(() => {
  const c = phone.call
  if (!c?.answeredAt) return ''
  const s = Math.max(0, Math.floor((now.value - new Date(c.answeredAt).getTime()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

const callState = computed(() => {
  const c = phone.call
  if (!c) return ''
  if (c.state === 'ringing') return c.direction === 'in' ? 'Incoming call' : 'Ringing…'
  if (c.state === 'dialing') return 'Calling…'
  if (c.state === 'active') return `On the call · ${callTime.value}`
  return 'Ended'
})

async function call(): Promise<void> {
  if (!number.value.trim()) return
  await dial(number.value)
}

const who = (r: { name: string; number: string }) => (r.name ? `${r.name} · ${pretty(r.number)}` : pretty(r.number))
function pretty(n: string): string {
  const m = /^1?(\d{3})(\d{3})(\d{4})$/.exec(n)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n || 'unknown'
}
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const length = (r: CallRecord) => (r.answeredAt ? `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, '0')}` : '')
const openTranscript = (file: string) => window.open(`/?view=${encodeURIComponent(file)}`, '_blank', 'noopener')
</script>

<template>
  <div class="vstack gap-4">
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <span class="text-sm fg-3">
        Calls through Jarvis, on your VoIP.ms number. You talk here (headphones are best, so the other side doesn't hear itself). Every call is
        recorded and transcribed into the workspace's <code>calls/</code> folder, so you can ask Jarvis what was said. You can also say “call the
        dentist”: Jarvis reads the number back and waits for your yes.
      </span>
    </div>

    <div v-if="!phone.enabled" class="alert theme-secondary m-0">
      The phone isn't set up: put the VoIP.ms settings (<code>VOIPMS_SIP_SERVER</code>, <code>VOIPMS_SIP_USER</code>, <code>VOIPMS_SIP_PASSWORD</code>,
      <code>VOIPMS_DID</code>) in <code>apps/server/.env.local</code> and restart the server. See <code>docs/phone.md</code>.
    </div>

    <template v-else>
      <div class="d-flex align-items-center gap-3 flex-wrap text-sm">
        <span class="badge" :class="lineBadge.theme">{{ lineBadge.text }}</span>
        <span v-if="phone.audioOn" class="badge theme-info badge-subtle">This device is on the call</span>
      </div>

      <div v-if="phone.error" class="alert theme-danger m-0" role="alert">{{ phone.error }}</div>

      <!-- The call in progress -->
      <div v-if="phone.call" class="card">
        <div class="card-body vstack gap-3">
          <div class="d-flex align-items-center gap-3 flex-wrap">
            <div class="vstack">
              <span class="fw-semibold fs-5">{{ phone.call.name || phone.call.display }}</span>
              <span class="text-sm fg-3">{{ phone.call.name ? phone.call.display + ' · ' : '' }}{{ callState }}</span>
            </div>
            <div class="d-flex gap-2 ms-auto flex-wrap">
              <template v-if="phone.call.direction === 'in' && phone.call.state === 'ringing'">
                <button type="button" class="btn-solid theme-success" @click="answer">Answer</button>
                <button type="button" class="btn-outline theme-danger" @click="decline">Decline</button>
              </template>
              <template v-else>
                <button v-if="!phone.audioOn && !phone.call.deviceJoined" type="button" class="btn-outline theme-primary" @click="joinAudio">Talk on this device</button>
                <button v-if="phone.audioOn" type="button" class="btn-outline theme-secondary" @click="leaveAudio">Leave on this device</button>
                <button type="button" :class="phone.call.muted ? 'btn-solid theme-warning' : 'btn-outline theme-secondary'" @click="setMuted(!phone.call.muted)">{{ phone.call.muted ? 'Unmute' : 'Mute' }}</button>
                <button type="button" class="btn-solid theme-danger" @click="hangUp">Hang up</button>
              </template>
            </div>
          </div>
          <div v-if="phone.call.state === 'active'" class="d-flex gap-2 flex-wrap" aria-label="Keypad">
            <button v-for="k in KEYS" :key="k" type="button" class="btn-outline theme-secondary btn-sm font-monospace" style="min-width: 2.5rem" @click="sendDigit(k)">{{ k }}</button>
          </div>
        </div>
      </div>

      <!-- Dial -->
      <form v-else class="d-flex gap-2 align-items-center flex-wrap" @submit.prevent="call">
        <input v-model="number" class="form-control" style="max-width: 16rem" inputmode="tel" autocomplete="tel" placeholder="613-555-0123" aria-label="Number to call" />
        <button type="submit" class="btn-solid theme-success" :disabled="phone.line.state !== 'registered' || !number.trim()">Call</button>
      </form>

      <!-- Texts -->
      <div class="vstack gap-2">
        <span class="fw-semibold">Texts</span>
        <span v-if="!phone.texts.enabled" class="text-sm fg-3">
          Texts need the VoIP.ms API: <code>VOIPMS_API_USER</code> (your login email) and <code>VOIPMS_API_PASSWORD</code> in <code>apps/server/.env.local</code>.
        </span>
        <template v-else>
          <div v-if="phone.texts.error" class="alert theme-warning m-0 text-sm">{{ phone.texts.error }}</div>
          <form class="d-flex gap-2 align-items-start flex-wrap" @submit.prevent="send">
            <input v-model="textTo" class="form-control" style="max-width: 12rem" inputmode="tel" placeholder="613-555-0123" aria-label="Text to" />
            <textarea v-model="textBody" class="form-control" style="flex: 1 1 18rem" rows="1" maxlength="960" placeholder="Message" aria-label="Message"></textarea>
            <button type="submit" class="btn-solid theme-primary" :disabled="!textTo.trim() || !textBody.trim()">Send</button>
          </form>
          <span v-if="!phone.texts.list.length" class="text-sm fg-3">No texts yet.</span>
          <div v-for="t in phone.texts.list" :key="t.id" class="d-flex gap-3 text-sm border-bottom pb-2" :class="t.direction === 'out' ? 'fg-3' : ''">
            <span :title="t.direction === 'out' ? 'Sent' : 'Received'">{{ t.direction === 'out' ? '↗' : '↙' }}</span>
            <span class="fw-semibold text-nowrap">{{ pretty(t.contact) }}</span>
            <span class="flex-grow-1" style="white-space: pre-wrap">{{ t.message }}</span>
            <span class="fg-3 text-nowrap">{{ when(t.at) }}</span>
          </div>
        </template>
      </div>

      <!-- Recent calls -->
      <div class="vstack gap-2">
        <span class="fw-semibold">Recent calls</span>
        <span v-if="!phone.calls.length" class="text-sm fg-3">No calls yet.</span>
        <div v-for="r in phone.calls" :key="r.id" class="d-flex align-items-center gap-3 flex-wrap text-sm border-bottom pb-2">
          <span :title="r.direction === 'out' ? 'Outgoing' : 'Incoming'">{{ r.direction === 'out' ? '↗' : r.answeredAt ? '↙' : '✕' }}</span>
          <span class="fw-semibold">{{ who(r) }}</span>
          <span class="fg-3">{{ when(r.startedAt) }}</span>
          <span v-if="length(r)" class="fg-3 font-monospace">{{ length(r) }}</span>
          <span class="fg-3">{{ r.endReason }}</span>
          <span class="ms-auto d-flex gap-2 align-items-center">
            <span v-if="r.status === 'transcribing'" class="badge theme-secondary badge-subtle">transcribing…</span>
            <span v-else-if="r.status === 'failed'" class="badge theme-warning badge-subtle">not transcribed</span>
            <button v-if="r.transcript" type="button" class="btn-outline theme-secondary btn-sm" @click="openTranscript(r.transcript)">Transcript</button>
            <a v-for="(rec, i) in r.recordings" :key="i" :href="`/api/phone/calls/${r.id}/${i + 1}.ogg`" target="_blank" rel="noopener" class="btn-outline theme-secondary btn-sm">🎧 {{ rec.who }}</a>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
