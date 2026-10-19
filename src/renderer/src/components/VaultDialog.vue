<template>
  <dialog
    ref="dialog"
    class="vault-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="requestClose"
    @click="onBackdrop"
  >
    <header class="dialog-heading">
      <h2 :id="titleId">{{ title }}</h2>
      <button class="icon-button" aria-label="关闭对话框" :disabled="busy" @click="requestClose">
        <UiIcon name="close" />
      </button>
    </header>
    <slot />
  </dialog>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({ title: String, busy: Boolean })
const emit = defineEmits(['close'])
const titleId = useId()
const dialog = ref(null)
let previousFocus
function requestClose() {
  if (!props.busy) emit('close')
}
function onBackdrop(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    requestClose()
}
onMounted(() => {
  previousFocus = document.activeElement
  dialog.value.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  previousFocus?.focus()
})
</script>
