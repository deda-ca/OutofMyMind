<script setup lang="ts">
import { ref } from 'vue'
import { signIn } from '../auth'

const key = ref('')
const error = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (!key.value.trim() || busy.value) return
  busy.value = true
  error.value = (await signIn(key.value)) ?? ''
  busy.value = false
}
</script>

<template>
  <div class="row justify-content-center mt-6">
    <div class="col-12 lg:col-6">
      <form class="card" @submit.prevent="submit">
        <div class="card-header"><span class="fw-semibold">Sign in to Jarvis</span></div>
        <div class="card-body vstack gap-4">
          <p class="m-0">
            Enter the access key. It's shown in the server's log when it starts (or set it yourself as
            <code>ACCESS_KEY</code> in <code>apps/server/.env.local</code>). You only need to do this once on each device.
          </p>
          <div class="vstack gap-1">
            <label for="access-key" class="form-label m-0">Access key</label>
            <input
              id="access-key"
              v-model="key"
              class="form-control form-control-lg font-monospace"
              autocomplete="current-password"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autofocus
            />
          </div>
          <div v-if="error" class="alert theme-danger m-0" role="alert">{{ error }}</div>
          <div>
            <button type="submit" class="btn-solid theme-primary btn-lg" :disabled="busy || !key.trim()">
              <span v-if="busy" class="spinner-border spinner-sm" aria-hidden="true"></span>
              Sign in
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
