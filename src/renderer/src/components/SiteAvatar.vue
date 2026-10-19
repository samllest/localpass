<template>
  <span
    class="site-avatar"
    :class="{ large, 'app-avatar': record.category === 'app' }"
    aria-hidden="true"
  >
    <img v-if="icon && !failed" :src="icon" alt="" @error="failed = true" />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { safeIconData } from '../../../shared/site-metadata'

const props = defineProps({ record: { type: Object, required: true }, large: Boolean })
const failed = ref(false)
const icon = computed(() => safeIconData(props.record.icon_data))
const initial = computed(() =>
  [
    ...String(props.record.site_name || props.record.display_name || props.record.identity || '?')
  ][0].toUpperCase()
)
watch(icon, () => {
  failed.value = false
})
</script>
