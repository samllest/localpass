<template>
  <div class="credential-field">
    <div>
      <label>动态验证码</label>
      <p class="secret-text">{{ result?.code || '••••••' }}</p>
      <small v-if="result">{{ result.remaining }} 秒后更新</small
      ><small v-if="error" role="alert">{{ error }}</small>
    </div>
    <button class="text-button" @click="show">显示</button
    ><button
      class="icon-button"
      aria-label="复制验证码"
      :disabled="!result"
      @click="$emit('copy', result.code)"
    >
      <UiIcon name="copy" />
    </button>
  </div>
</template>
<script setup>
import { ref, onBeforeUnmount } from 'vue'
import UiIcon from './UiIcon.vue'
const props = defineProps({ id: Number })
defineEmits(['copy'])
const result = ref(null),
  error = ref('')
let timer, expiry
let generation = 0
async function update() {
  const current = generation
  try {
    const value = await window.localpass.getTotpCode(props.id)
    if (generation === current) result.value = value
  } catch (e) {
    error.value = e.message
    hide()
  }
}
function hide() {
  generation++
  clearInterval(timer)
  clearTimeout(expiry)
  result.value = null
}
async function show() {
  hide()
  error.value = ''
  const current = generation
  await update()
  if (generation !== current) return
  timer = setInterval(update, 1000)
  expiry = setTimeout(hide, 30000)
}
window.addEventListener('blur', hide)
onBeforeUnmount(() => {
  hide()
  window.removeEventListener('blur', hide)
})
</script>
