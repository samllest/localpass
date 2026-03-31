<template>
  <div class="card" :class="{ expanded: showHistory }">
    <div class="card-header">
      <div class="card-meta">
        <span class="card-id">#{{ String(item.id).padStart(3, '0') }}</span>
        <span class="card-category" :class="item.category">{{ item.category === 'web' ? '🌐' : '📦' }}</span>
      </div>
      <h3 class="card-name">{{ item.display_name }}</h3>
      <p class="card-identity">{{ item.identity }}</p>
    </div>

    <div class="card-creds">
      <div class="cred-row">
        <span class="cred-label">用户名</span>
        <span class="cred-value">{{ item.username || '—' }}</span>
        <button class="icon-btn" @click="$emit('copy', item.username)" title="复制">📋</button>
      </div>
      <div class="cred-row">
        <span class="cred-label">密码</span>
        <span class="cred-value pwd-val">{{ showPwd ? item.password : '••••••••••' }}</span>
        <button class="icon-btn" @click="showPwd = !showPwd" title="显示/隐藏">{{ showPwd ? '🙈' : '👁️' }}</button>
        <button class="icon-btn" @click="$emit('copy', item.password)" title="复制">📋</button>
      </div>
      <div class="cred-version">
        <span>v{{ item.version_tag }}</span>
        <span class="cred-date">{{ formatDate(item.captured_at) }}</span>
      </div>
    </div>

    <div class="card-actions">
      <button class="btn-history" @click="toggleHistory">
        {{ showHistory ? '▲ 收起' : '🕓 历史版本' }}
      </button>
      <div class="card-action-right">
        <button class="btn-edit" @click="$emit('edit', item)">✏️ 编辑</button>
        <button class="btn-del" @click="confirmDelete">🗑️</button>
      </div>
    </div>

    <transition name="slide">
      <div v-if="showHistory" class="history-panel">
        <div v-if="historyLoading" class="history-loading">加载中...</div>
        <div v-else-if="history.length === 0" class="history-empty">暂无历史版本</div>
        <div
          v-for="h in history"
          :key="h.id"
          class="history-row"
          :class="{ latest: h.is_latest }"
        >
          <span class="h-version">v{{ h.version_tag }}</span>
          <span class="h-user">{{ h.username || '—' }}</span>
          <span class="h-pwd">{{ h.password || '—' }}</span>
          <span class="h-date">{{ formatDate(h.captured_at) }}</span>
          <button class="icon-btn" @click="$emit('copy', h.password)" title="复制">📋</button>
        </div>
      </div>
    </transition>

    <div v-if="confirmingDelete" class="delete-overlay">
      <p>确认删除 <strong>{{ item.display_name }}</strong>？</p>
      <div class="delete-btns">
        <button class="btn-cancel" @click="confirmingDelete = false">取消</button>
        <button class="btn-confirm-del" @click="doDelete">确认删除</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({ item: Object })
const emit = defineEmits(['edit', 'delete', 'copy'])

const showPwd = ref(false)
const showHistory = ref(false)
const historyLoading = ref(false)
const history = ref([])
const confirmingDelete = ref(false)

async function toggleHistory() {
  showHistory.value = !showHistory.value
  if (showHistory.value && history.value.length === 0) {
    historyLoading.value = true
    history.value = await window.localpass.getHistory(props.item.id)
    historyLoading.value = false
  }
}

function confirmDelete() {
  confirmingDelete.value = true
}

function doDelete() {
  emit('delete', props.item.id)
  confirmingDelete.value = false
}

function formatDate(dt) {
  if (!dt) return ''
  return new Date(dt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>
