<template>
  <svg
    class="ui-icon"
    :width="icon.w"
    :height="icon.h"
    :viewBox="`0 0 ${icon.w} ${icon.h}`"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    v-html="icon.body"
  />
</template>

<script setup>
import { computed } from 'vue'
import { ICONS } from './icons.js'
import { WORKSPACE_ICONS } from './workspace-icons'
import { ARDOT_ICONS } from './ardot-icons'

const props = defineProps({ name: { type: String, required: true } })

const icon = computed(() => {
  const item = ARDOT_ICONS[props.name] || WORKSPACE_ICONS[props.name] || ICONS[props.name]
  if (!item) console.warn(`[UiIcon] 未找到图标: ${props.name}`)
  // Keep the source geometry; action icons inherit the active theme's text color.
  if (props.name === 'plus-white' && item)
    return { ...item, body: item.body.replace(/#FFF(?:FFF)?\b/gi, 'currentColor') }
  return item || { w: 16, h: 16, body: '' }
})
</script>
