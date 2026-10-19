<template>
  <div class="card" :class="{ expanded: hasOpenHistory }">
    <div class="card-header">
      <div class="card-meta">
        <span class="card-id">#{{ String(item.id).padStart(3, '0') }}</span>
        <span class="card-category" :class="item.category">{{
          item.category === 'web' ? 'WEB' : 'APP'
        }}</span>
        <span v-if="item.accounts.length > 1" class="account-count"
          >{{ item.accounts.length }} 个账号</span
        >
      </div>
      <h3 class="card-name">{{ item.display_name }}</h3>
      <p class="card-identity">{{ item.identity }}</p>
    </div>

    <div class="account-list">
      <div
        v-for="(account, index) in item.accounts"
        :key="account.id || account.app_id"
        class="account-entry"
      >
        <div class="account-heading">
          <span class="account-label">账号 {{ index + 1 }}</span>
          <span class="account-username">{{ account.username || '未填写用户名' }}</span>
        </div>

        <div class="card-creds">
          <div class="cred-row">
            <span class="cred-label">用户名</span>
            <span class="cred-value">{{ account.username || '—' }}</span>
            <button class="icon-btn" @click="$emit('copy', account.username)" title="复制用户名">
              <span class="icon-copy" aria-hidden="true" />
            </button>
          </div>
          <div class="cred-row">
            <span class="cred-label">密码</span>
            <span class="cred-value pwd-val">{{
              isPasswordVisible(account) ? account.password : '••••••••••'
            }}</span>
            <button
              class="icon-btn"
              @click="togglePassword(account)"
              :title="isPasswordVisible(account) ? '隐藏密码' : '显示密码'"
            >
              <span class="icon-eye" aria-hidden="true" />
            </button>
            <button class="icon-btn" @click="$emit('copy', account.password)" title="复制密码">
              <span class="icon-copy" aria-hidden="true" />
            </button>
          </div>
          <div class="cred-version">
            <span>v{{ account.version_tag }}</span>
            <span class="cred-date">{{ formatDate(account.captured_at) }}</span>
          </div>
        </div>

        <div class="account-actions">
          <button class="btn-history" @click="toggleHistory(account)">
            <span class="icon-history" aria-hidden="true" />
            {{ isHistoryOpen(account) ? '收起历史' : '历史版本' }}
          </button>
          <div class="card-action-right">
            <button class="btn-edit" @click="$emit('edit', account)">
              <span class="icon-edit" aria-hidden="true" />编辑
            </button>
            <button class="btn-del" @click="confirmDelete(account)" title="删除账号">
              <span class="icon-trash" aria-hidden="true" />
            </button>
          </div>
        </div>

        <transition name="slide">
          <div v-if="isHistoryOpen(account)" class="history-panel">
            <div v-if="historyLoading[idFor(account)]" class="history-loading">加载中...</div>
            <div v-else-if="!(histories[idFor(account)] || []).length" class="history-empty">
              暂无历史版本
            </div>
            <div
              v-for="historyItem in histories[idFor(account)] || []"
              :key="historyItem.id"
              class="history-row"
              :class="{ latest: historyItem.is_latest }"
            >
              <span class="h-version">v{{ historyItem.version_tag }}</span>
              <span class="h-user">{{ historyItem.username || '—' }}</span>
              <span class="h-pwd">{{ historyItem.password || '—' }}</span>
              <span class="h-date">{{ formatDate(historyItem.captured_at) }}</span>
              <button
                class="icon-btn"
                @click="$emit('copy', historyItem.password)"
                title="复制历史密码"
              >
                <span class="icon-copy" aria-hidden="true" />
              </button>
            </div>
          </div>
        </transition>

        <div v-if="index < item.accounts.length - 1" class="account-divider" />
      </div>
    </div>

    <div v-if="confirmingDelete" class="delete-overlay">
      <p>
        确认删除账号 <strong>{{ confirmingDelete.username || '未填写用户名' }}</strong
        >？
      </p>
      <div class="delete-btns">
        <button class="btn-cancel" @click="confirmingDelete = null">取消</button>
        <button class="btn-confirm-del" @click="doDelete">确认删除</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'

defineProps({ item: Object })
const emit = defineEmits(['edit', 'delete', 'copy'])

const visiblePasswords = reactive({})
const histories = reactive({})
const historyLoading = reactive({})
const openHistories = reactive({})
const confirmingDelete = ref(null)

const hasOpenHistory = computed(() => Object.values(openHistories).some(Boolean))

function idFor(account) {
  return account.id || account.app_id
}

function isPasswordVisible(account) {
  return Boolean(visiblePasswords[idFor(account)])
}

function togglePassword(account) {
  const id = idFor(account)
  visiblePasswords[id] = !visiblePasswords[id]
}

function isHistoryOpen(account) {
  return Boolean(openHistories[idFor(account)])
}

async function toggleHistory(account) {
  const id = idFor(account)
  openHistories[id] = !openHistories[id]
  if (!openHistories[id] || histories[id]) return

  historyLoading[id] = true
  try {
    histories[id] = await window.localpass.getHistory(id)
  } finally {
    historyLoading[id] = false
  }
}

function confirmDelete(account) {
  confirmingDelete.value = account
}

function doDelete() {
  if (!confirmingDelete.value) return
  emit('delete', idFor(confirmingDelete.value))
  confirmingDelete.value = null
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
