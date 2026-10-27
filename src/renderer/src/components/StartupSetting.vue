<template>
  <div class="preference-row">
    <div>
      <strong id="startup-label">开机自启</strong>
      <p id="startup-description">
        {{
          state?.supported === false
            ? state.reason
            : '登录 Windows 后自动打开 LocalPass，仍需主密码解锁。'
        }}
      </p>
      <p v-if="error" class="form-err" role="alert">{{ error }}</p>
    </div>
    <button v-if="!state && error" class="button button-outline" :disabled="busy" @click="load">
      重试
    </button>
    <button
      v-else
      class="button button-outline"
      role="switch"
      aria-labelledby="startup-label"
      aria-describedby="startup-description"
      :aria-checked="state?.enabled || false"
      :aria-busy="busy"
      :disabled="busy || !state?.supported"
      @click="toggle"
    >
      {{ busy ? '处理中…' : state?.enabled ? '已开启' : '已关闭' }}
    </button>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const state = ref(null)
const busy = ref(false)
const error = ref('')

async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    state.value = await window.localpass.getStartupState()
  } catch (cause) {
    state.value = null
    error.value = cause.message || '无法读取开机自启设置，请重试。'
  } finally {
    busy.value = false
  }
}

async function toggle() {
  if (busy.value || !state.value?.supported) return
  busy.value = true
  error.value = ''
  try {
    state.value = await window.localpass.setStartupEnabled(!state.value.enabled)
  } catch (cause) {
    error.value = cause.message || '无法修改开机自启设置，请重试。'
    // A system error may occur after the write; show the actual resulting state.
    try {
      state.value = await window.localpass.getStartupState()
    } catch {
      state.value = null
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  window.addEventListener('focus', load)
})
onBeforeUnmount(() => window.removeEventListener('focus', load))
</script>
