<template>
  <span class="site-address"
    >{{ address.host }}<b v-if="address.port">:{{ address.port }}</b></span
  >
</template>

<script setup>
import { computed } from 'vue'
import { websiteAddress } from '../../../shared/site-metadata'

const props = defineProps({
  identity: { type: String, default: '' },
  website: { type: Boolean, default: true }
})
const address = computed(() => {
  const url = props.website ? websiteAddress(props.identity) : null
  return url ? { host: url.hostname, port: url.port } : { host: props.identity, port: '' }
})
</script>
