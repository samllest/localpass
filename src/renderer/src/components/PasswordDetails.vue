<template>
  <section class="password-details" aria-label="网站详情">
    <div class="detail-topline">
      <button class="text-button back-button" @click="$emit('back')">
        <UiIcon name="chevron-right" />返回列表
      </button>
      <span class="detail-kind">{{ group.category === 'app' ? '应用密码' : '网站密码' }}</span>
      <div class="detail-top-actions">
        <button class="button button-secondary" @click="$emit('add')">
          <UiIcon name="plus-white" />添加账号
        </button>
        <details v-if="group.accounts.length === 1" ref="actionsMenu" class="detail-menu">
          <summary class="icon-button" aria-label="更多操作"><UiIcon name="more" /></summary>
          <div class="detail-menu-items">
            <button class="danger-text" @click="menuAction('delete', group.accounts[0])">
              <UiIcon name="trash" />删除
            </button>
          </div>
        </details>
      </div>
    </div>
    <div class="detail-scroll">
      <div class="detail-title">
        <SiteAvatar :record="group" large />
        <div>
          <h1>{{ group.display_name }}</h1>
          <p><SiteAddress :identity="group.identity" :website="group.category === 'web'" /></p>
        </div>
      </div>
      <dl v-if="group.page_title || group.project_name" class="site-tab-metadata site-metadata">
        <div v-if="group.project_name">
          <dt>项目名称</dt>
          <dd>{{ group.project_name }}</dd>
        </div>
        <div v-if="group.page_title">
          <dt>网页标签</dt>
          <dd>{{ group.page_title }}</dd>
        </div>
      </dl>
      <div class="detail-section-heading">
        <h2>登录账号</h2>
        <span>{{ group.accounts.length }} 个已保存账号</span>
      </div>
      <article
        v-for="(account, index) in group.accounts"
        :key="recordId(account)"
        class="account-section"
        @contextmenu.prevent="accountMenu(account)"
      >
        <header class="multi-account-heading">
          <h3 v-if="group.accounts.length > 1">账号 {{ index + 1 }}</h3>
          <div>
            <button class="text-button" @click="accountAction('edit', account)">编辑</button
            ><button
              v-if="group.accounts.length > 1"
              class="text-button danger-text"
              @click="accountAction('delete', account)"
            >
              删除
            </button>
          </div>
        </header>
        <div class="credential-card">
          <TotpCode v-if="account.has_totp" :id="recordId(account)" @copy="$emit('copy', $event)" />
          <div class="credential-field">
            <div>
              <label>用户名</label>
              <p>{{ account.username || '未填写用户名' }}</p>
            </div>
            <button
              class="icon-button"
              aria-label="复制用户名"
              :disabled="!account.username"
              @click="$emit('copy', account.username)"
            >
              <UiIcon name="copy" />
            </button>
          </div>
          <div class="credential-field">
            <div>
              <label>密码</label>
              <p class="secret-text" :class="{ concealed: !visible.has(recordId(account)) }">
                {{ visible.has(recordId(account)) ? account.password : '••••••••••' }}
              </p>
            </div>
            <button
              class="icon-button"
              :aria-label="visible.has(recordId(account)) ? '隐藏密码' : '显示密码'"
              :aria-pressed="visible.has(recordId(account))"
              @click="togglePassword(recordId(account))"
            >
              <UiIcon name="eye" /></button
            ><button
              class="icon-button"
              aria-label="复制密码"
              @click="$emit('copy', account.password)"
            >
              <UiIcon name="copy" />
            </button>
          </div>
        </div>
        <p v-if="account.notes || account.tags || account.favorite" class="field-hint">
          {{ account.favorite ? '★ 收藏 · ' : '' }}{{ account.tags
          }}{{ account.notes ? ` · ${account.notes}` : '' }}
        </p>
        <footer v-if="group.accounts.length > 1" class="credential-actions">
          <span>更新于 {{ formatDate(account.captured_at) }}</span
          ><button
            class="text-button history-toggle"
            :aria-expanded="historyOpen === recordId(account)"
            @click="toggleHistory(account)"
          >
            <UiIcon name="nav-recent" />历史版本
          </button>
        </footer>
        <PasswordHistory
          v-if="group.accounts.length > 1 && historyOpen === recordId(account)"
          :items="history"
          :visible="visible"
          :loading="historyLoading"
          :error="historyError"
          @retry="loadHistory(historyAccount)"
          @toggle="togglePassword"
          @copy="$emit('copy', $event)"
        />
      </article>
      <div class="detail-section-heading">
        <h2>{{ group.category === 'app' ? '应用信息' : '网站信息' }}</h2>
      </div>
      <dl class="site-information">
        <div>
          <dt>{{ group.category === 'app' ? '应用名称' : '网站名称' }}</dt>
          <dd>{{ group.site_name || group.display_name }}</dd>
        </div>
        <div>
          <dt>{{ group.category === 'app' ? '应用标识' : '网站地址' }}</dt>
          <dd>
            <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer"
              ><span
                ><span class="address-protocol">{{ protocol }}</span
                ><SiteAddress :identity="group.identity" /></span
              ><UiIcon name="external" /></a
            ><span v-else>{{ group.identity }}</span
            ><span v-if="localAddress" class="address-tag">内网</span>
          </dd>
        </div>
      </dl>
      <template v-if="group.accounts.length === 1">
        <footer class="credential-actions">
          <span>更新于 {{ formatDate(group.accounts[0].captured_at) }}</span
          ><button
            class="text-button history-toggle"
            :aria-expanded="historyOpen === recordId(group.accounts[0])"
            @click="toggleHistory(group.accounts[0])"
          >
            <UiIcon name="nav-recent" />历史版本
          </button>
        </footer>
        <PasswordHistory
          v-if="historyOpen === recordId(group.accounts[0])"
          :items="history"
          :visible="visible"
          :loading="historyLoading"
          :error="historyError"
          @retry="loadHistory(historyAccount)"
          @toggle="togglePassword"
          @copy="$emit('copy', $event)"
        />
      </template>
      <p class="page-footnote">复制内容 30 秒后自动从剪贴板清除</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import SiteAvatar from './SiteAvatar.vue'
import SiteAddress from './SiteAddress.vue'
import PasswordHistory from './PasswordHistory.vue'
import TotpCode from './TotpCode.vue'
import { formatDate, recordId, recordWebsiteUrl } from '../utils/vault'

const props = defineProps({ group: { type: Object, required: true } })
const emit = defineEmits(['back', 'copy', 'edit', 'delete', 'add', 'changed'])
const actionsMenu = ref(null)
const visible = ref(new Set())
const historyOpen = ref(null)
const history = ref([])
const historyLoading = ref(false)
const historyError = ref('')
async function accountMenu(account) {
  const action = await window.localpass.contextMenu({ group: false })
  if (action === 'username') emit('copy', account.username)
  if (action === 'password') emit('copy', account.password)
  if (action === 'edit') emit('edit', account)
  if (action === 'delete') emit('delete', account)
  if (action === 'history') toggleHistory(account)
  if (action === 'favorite') {
    await window.localpass.updateApp({ app_id: recordId(account), favorite: !account.favorite })
    emit('changed')
  }
}
const url = computed(() => (props.group.category === 'web' ? recordWebsiteUrl(props.group) : null))
const protocol = computed(() => (url.value ? new URL(url.value).protocol + '//' : ''))
const localAddress = computed(() => {
  if (!url.value) return false
  const host = new URL(url.value).hostname
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
  )
})
const historyAccount = computed(() =>
  props.group.accounts.find((account) => recordId(account) === historyOpen.value)
)
const timers = new Map()
let historyToken = 0
function accountAction(action, account) {
  hideSecrets()
  emit(action, account)
}
function menuAction(action, account) {
  if (actionsMenu.value) actionsMenu.value.open = false
  accountAction(action, account)
}
function closeMenu(event) {
  if (actionsMenu.value && (!actionsMenu.value.contains(event.target) || event.key === 'Escape'))
    actionsMenu.value.open = false
}
function hideSecrets() {
  visible.value.clear()
  timers.forEach(clearTimeout)
  timers.clear()
}
function togglePassword(id) {
  clearTimeout(timers.get(id))
  if (visible.value.has(id)) {
    visible.value.delete(id)
    timers.delete(id)
  } else {
    visible.value.add(id)
    timers.set(
      id,
      setTimeout(() => {
        visible.value.delete(id)
        timers.delete(id)
      }, 30_000)
    )
  }
}
async function loadHistory(account) {
  const token = ++historyToken
  historyLoading.value = true
  historyError.value = ''
  history.value = []
  try {
    const records = await window.localpass.getHistory(recordId(account))
    if (token === historyToken) history.value = records
  } catch (error) {
    if (token === historyToken) historyError.value = error.message || '历史记录加载失败'
  } finally {
    if (token === historyToken) historyLoading.value = false
  }
}
function toggleHistory(account) {
  hideSecrets()
  const id = recordId(account)
  if (historyOpen.value === id) {
    historyOpen.value = null
    history.value = []
    historyToken++
  } else {
    historyOpen.value = id
    loadHistory(account)
  }
}
watch(
  () => props.group,
  () => {
    hideSecrets()
    historyOpen.value = null
    history.value = []
    historyToken++
  }
)
onMounted(() => {
  window.addEventListener('blur', hideSecrets)
  document.addEventListener('pointerdown', closeMenu)
  document.addEventListener('keydown', closeMenu)
})
onBeforeUnmount(() => {
  historyToken++
  hideSecrets()
  history.value = []
  window.removeEventListener('blur', hideSecrets)
  document.removeEventListener('pointerdown', closeMenu)
  document.removeEventListener('keydown', closeMenu)
})
</script>
