<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { answer, decline, dial, hangUp, joinAudio, leaveAudio, loadPhone, phone, saveRules, sendDigit, sendText, setMuted, type CallRecord, type Contact, type PhoneRules } from '../phone'

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

const MARVIN_STAGE: Record<string, string> = {
  greeting: 'answering',
  asking: 'asking who it is',
  'ringing owner': 'ringing your cell',
  announcing: 'telling you on your cell',
  'taking a message': 'taking a message',
}

const callState = computed(() => {
  const c = phone.call
  if (!c) return ''
  if (c.marvin) return `${phone.assistant} is ${MARVIN_STAGE[c.marvin] ?? c.marvin}`
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
const OUTCOME: Record<string, string> = {
  connected: 'put through',
  message: 'left a message',
  'hung up': 'hung up on Marvin',
  'picked up': 'you picked up',
  blocked: 'blocked',
}
const outcome = (r: CallRecord) => (r.outcome ? (r.outcome === 'hung up' ? `hung up on ${phone.assistant}` : OUTCOME[r.outcome]) : r.endReason)

// ------------------------------------------------------------------ rules (who gets put through)

/** The rules being edited, as text: one contact per line, "613-555-0123 Mom". */
const draft = ref<{ answer: PhoneRules['answer']; always: string; blocked: string; quietFrom: string; quietTo: string; recordingNotice: boolean } | null>(null)
const rulesSaved = ref(false)
const toLines = (list: Contact[]) => list.map((c) => `${pretty(c.number)}${c.name ? ` ${c.name}` : ''}`).join('\n')
function fromLines(text: string): Contact[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([+\d()\s.-]{7,})\s*(.*)$/.exec(line)
      return m ? { number: m[1]!.trim(), name: m[2]!.trim() } : { number: line, name: '' }
    })
}
function editRules(): void {
  const r = phone.rules
  if (!r) return
  draft.value = { answer: r.answer, always: toLines(r.always), blocked: toLines(r.blocked), quietFrom: r.quietFrom, quietTo: r.quietTo, recordingNotice: r.recordingNotice }
  rulesSaved.value = false
}
async function storeRules(): Promise<void> {
  const d = draft.value
  if (!d) return
  const ok = await saveRules({ answer: d.answer, always: fromLines(d.always), blocked: fromLines(d.blocked), quietFrom: d.quietFrom, quietTo: d.quietTo, recordingNotice: d.recordingNotice })
  if (ok) {
    draft.value = null
    rulesSaved.value = true
  }
}
const rulesSummary = computed(() => {
  const r = phone.rules
  if (!r) return ''
  const a = phone.assistant
  const parts = [r.answer === 'marvin' ? (phone.ownerCell ? `${a} answers, asks who it is, and rings your cell` : `${a} answers and takes a message (no OWNER_CELL to ring)`) : `Your screens ring first; ${a} takes a message if nobody picks up`]
  if (r.always.length) parts.push(`${r.always.length} always put through`)
  if (r.blocked.length) parts.push(`${r.blocked.length} blocked`)
  if (r.quietFrom && r.quietTo) parts.push(`quiet ${r.quietFrom}–${r.quietTo} (messages only)`)
  return parts.join(' · ')
})

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
              <template v-if="phone.call.marvin">
                <button type="button" class="btn-solid theme-success" title="Take the call on this device" @click="answer">Pick up</button>
                <button type="button" class="btn-outline theme-danger" @click="hangUp">Hang up</button>
              </template>
              <template v-else-if="phone.call.direction === 'in' && phone.call.state === 'ringing'">
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
          <div v-if="phone.call.said" class="text-sm">
            <span class="fg-3">They said:</span> <q>{{ phone.call.said }}</q>
          </div>
          <div v-if="phone.call.state === 'active' && !phone.call.marvin" class="d-flex gap-2 flex-wrap" aria-label="Keypad">
            <button v-for="k in KEYS" :key="k" type="button" class="btn-outline theme-secondary btn-sm font-monospace" style="min-width: 2.5rem" @click="sendDigit(k)">{{ k }}</button>
          </div>
        </div>
      </div>

      <!-- Dial -->
      <form v-else class="d-flex gap-2 align-items-center flex-wrap" @submit.prevent="call">
        <input v-model="number" class="form-control" style="max-width: 16rem" inputmode="tel" autocomplete="tel" placeholder="613-555-0123" aria-label="Number to call" />
        <button type="submit" class="btn-solid theme-success" :disabled="phone.line.state !== 'registered' || !number.trim()">Call</button>
      </form>

      <!-- Rules: who gets put through -->
      <div v-if="phone.rules" class="vstack gap-2">
        <div class="d-flex align-items-center gap-3 flex-wrap">
          <span class="fw-semibold">Incoming calls</span>
          <span class="text-sm fg-3">{{ rulesSummary }}</span>
          <span v-if="rulesSaved" class="badge theme-success badge-subtle">saved</span>
          <button v-if="!draft" type="button" class="btn-outline theme-secondary btn-sm ms-auto" @click="editRules">Change</button>
        </div>
        <form v-if="draft" class="card" @submit.prevent="storeRules">
          <div class="card-body vstack gap-3 text-sm">
            <div class="vstack gap-1">
              <label class="d-flex gap-2 align-items-center"><input v-model="draft.answer" type="radio" value="marvin" /> {{ phone.assistant }} answers: asks who's calling and what it's about, then rings your cell and tells you. Press 1 (or say "connect") to talk, 2 for a message.</label>
              <label class="d-flex gap-2 align-items-center"><input v-model="draft.answer" type="radio" value="screens" /> Your screens ring first; {{ phone.assistant }} takes a message if nobody picks up.</label>
              <span v-if="!phone.ownerCell" class="fg-3">No <code>OWNER_CELL</code> in <code>.env.local</code>: {{ phone.assistant }} can only take messages.</span>
            </div>
            <div class="d-flex gap-3 flex-wrap">
              <label class="vstack gap-1" style="flex: 1 1 16rem">
                <span>Always put through (one per line: number, then a name {{ phone.assistant }} says)</span>
                <textarea v-model="draft.always" class="form-control font-monospace" rows="3" placeholder="613-555-0123 Mom"></textarea>
              </label>
              <label class="vstack gap-1" style="flex: 1 1 16rem">
                <span>Blocked (turned away without answering)</span>
                <textarea v-model="draft.blocked" class="form-control font-monospace" rows="3" placeholder="613-555-0199"></textarea>
              </label>
            </div>
            <div class="d-flex gap-2 align-items-center flex-wrap">
              <span>Quiet hours (messages only, except "always"):</span>
              <input v-model="draft.quietFrom" type="time" class="form-control" style="max-width: 9rem" aria-label="Quiet from" />
              <span>to</span>
              <input v-model="draft.quietTo" type="time" class="form-control" style="max-width: 9rem" aria-label="Quiet until" />
              <button v-if="draft.quietFrom || draft.quietTo" type="button" class="btn-outline theme-secondary btn-sm" @click="(draft.quietFrom = ''), (draft.quietTo = '')">None</button>
            </div>
            <label class="d-flex gap-2 align-items-center">
              <input v-model="draft.recordingNotice" type="checkbox" /> {{ phone.assistant }} says "This call is recorded" (always for US numbers, where some states need everyone's consent)
            </label>
            <span class="fg-3">Caller ID can be faked: these decide who gets put through, never what anyone can make {{ phone.assistant }} do.</span>
            <div class="d-flex gap-2">
              <button type="submit" class="btn-solid theme-primary btn-sm">Save</button>
              <button type="button" class="btn-outline theme-secondary btn-sm" @click="draft = null">Cancel</button>
            </div>
          </div>
        </form>
      </div>

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
          <span class="fg-3">{{ outcome(r) }}</span>
          <span v-if="r.recordingOff" class="badge theme-secondary badge-subtle" title="They asked not to be recorded: nothing was kept">not recorded</span>
          <span class="ms-auto d-flex gap-2 align-items-center">
            <span v-if="r.status === 'transcribing'" class="badge theme-secondary badge-subtle">transcribing…</span>
            <span v-else-if="r.status === 'failed'" class="badge theme-warning badge-subtle">not transcribed</span>
            <button v-if="r.transcript" type="button" class="btn-outline theme-secondary btn-sm" @click="openTranscript(r.transcript)">Transcript</button>
            <a v-for="(rec, i) in r.recordings" :key="i" :href="`/api/phone/calls/${r.id}/${i + 1}.ogg`" target="_blank" rel="noopener" class="btn-outline theme-secondary btn-sm">🎧 {{ rec.who }}</a>
          </span>
          <div v-if="r.said || r.message" class="w-100 vstack gap-1 ps-4">
            <span v-if="r.said"><span class="fg-3">Said who they were:</span> <q>{{ r.said }}</q></span>
            <span v-if="r.message"><span class="fg-3">Message:</span> <q>{{ r.message }}</q></span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
