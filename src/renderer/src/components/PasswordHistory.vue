<template>
  <section class="credential-history" aria-label="密码历史版本">
    <p v-if="loading" role="status">正在读取历史版本…</p>
    <p v-else-if="error" class="form-err" role="alert">
      {{ error }} <button class="text-button" @click="$emit('retry')">重试</button>
    </p>
    <template v-else>
      <p class="history-hint">历史密码默认隐藏，点击眼睛图标查看。</p>
      <div v-for="item in items" :key="item.id" class="history-item">
        <div>
          <strong
            >版本 {{ item.version_tag
            }}<span v-if="item.is_latest" class="current-version">当前</span></strong
          >
          <small>{{ formatDate(item.captured_at) }} · {{ item.username || '未填写用户名' }}</small>
          <p class="secret-text">
            {{ visible.has(`history-${item.id}`) ? item.password : '••••••••••••' }}
          </p>
        </div>
        <button
          class="icon-button"
          :aria-label="visible.has(`history-${item.id}`) ? '隐藏历史密码' : '显示历史密码'"
          :aria-pressed="visible.has(`history-${item.id}`)"
          @click="$emit('toggle', `history-${item.id}`)"
        >
          <UiIcon name="eye" />
        </button>
        <button class="icon-button" aria-label="复制历史密码" @click="$emit('copy', item.password)">
          <UiIcon name="copy" />
        </button>
      </div>
      <p v-if="!items.length" class="muted">暂无历史版本</p>
    </template>
  </section>
</template>

<script setup>
import UiIcon from './UiIcon.vue'
import { formatDate } from '../utils/vault'

defineProps({
  items: { type: Array, required: true },
  visible: { type: Set, required: true },
  loading: Boolean,
  error: String
})
defineEmits(['retry', 'toggle', 'copy'])
</script>
