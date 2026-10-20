<template>
  <div class="password-manager">
    <aside class="manager-sidebar">
      <div class="manager-brand">
        <span class="manager-brand-icon"><UiIcon name="brand-sidebar" /></span>
        <div><strong>LocalPass</strong><small>你的本地密码管理器</small></div>
      </div>
      <nav aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="['manager-nav', { active: page === item.id }]"
          :aria-current="page === item.id ? 'page' : undefined"
          @click="navigate(item.id)"
        >
          <UiIcon :name="item.icon" /><span>{{ item.label }}</span>
          <small v-if="item.id === 'passwords'" class="nav-count" aria-hidden="true">{{
            apps.length
          }}</small>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-privacy">
          <UiIcon name="shield" /><strong>只保存在这台设备 · 密码由你掌管</strong>
        </div>
        <button class="sidebar-lock" :disabled="locking" @click="lock">
          <UiIcon name="lock" /><span>{{ locking ? '正在锁定…' : '锁定密码库' }}</span>
        </button>
      </div>
    </aside>

    <div class="manager-workspace">
      <header class="manager-header" :class="{ 'settings-header': page === 'settings' }">
        <h1 class="manager-page-title">
          {{ page === 'passwords' ? '密码管理器' : page === 'checkup' ? '密码检查' : '设置' }}
        </h1>
        <div class="manager-search">
          <UiIcon name="search" />
          <input
            ref="searchInput"
            v-model="query"
            aria-label="搜索密码"
            placeholder="搜索网站、账号或地址"
            type="search"
            @input="onSearch"
          />
          <button v-if="query" class="icon-button" aria-label="清除搜索" @click="clearSearch">
            <UiIcon name="close" />
          </button>
          <kbd v-else>Ctrl K</kbd>
        </div>
        <button class="button button-primary header-add" @click="openAdd()">
          <UiIcon name="plus-white" /><span>{{
            page === 'settings' ? '＋ 添加密码' : '添加密码'
          }}</span>
        </button>
        <button
          class="icon-button mobile-lock"
          :disabled="locking"
          aria-label="锁定密码库"
          @click="lock"
        >
          <UiIcon name="lock" />
        </button>
      </header>

      <main
        ref="mainContent"
        class="manager-content"
        :class="{ 'vault-content': page === 'passwords' || page === 'checkup' }"
      >
        <div v-if="loadError" class="inline-error" role="alert">
          <span>{{ loadError }}</span
          ><button class="text-button" @click="refreshApps">重试</button>
        </div>
        <div v-if="loading && !apps.length" class="page-empty" role="status">
          <span class="spinner" />正在打开密码库…
        </div>
        <div
          v-else-if="page === 'passwords'"
          class="password-workbench"
          :class="{ 'has-selection': selectedGroup && !batchMode }"
        >
          <section ref="listPanel" class="password-list-panel" aria-label="密码列表">
            <div class="list-panel-heading">
              <h2>
                全部密码
                <span>{{
                  batchMode ? `已选择 ${selectedIds.size} 项` : `${groups.length} 个网站和应用`
                }}</span>
              </h2>
              <button
                v-if="filtered.length || batchMode"
                class="text-button batch-toggle"
                @click="toggleBatch"
              >
                {{ batchMode ? '取消' : '选择' }}
              </button>
            </div>
            <div class="list-toolbar">
              <div class="filter-chips" aria-label="密码类型">
                <button
                  v-for="item in categories"
                  :key="item.id"
                  :class="['filter-chip', { active: category === item.id }]"
                  :aria-pressed="category === item.id"
                  @click="category = item.id"
                >
                  {{ item.label }}
                </button>
              </div>
              <label class="sort-control"
                ><span class="sr-only">排序方式</span
                ><select v-model="sort">
                  <option value="name">名称排序</option>
                  <option value="recent">最近更新</option>
                </select></label
              >
            </div>
            <p v-if="query" class="sr-only" role="status">找到 {{ filtered.length }} 个结果</p>
            <div v-if="batchMode && filtered.length" class="selection-bar">
              <label
                ><input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate="selectedIds.size > 0 && !allSelected"
                  @change="toggleAll"
                />全选</label
              ><span>已选 {{ selectedIds.size }} 项</span
              ><button
                class="text-button danger-text"
                :disabled="!selectedIds.size"
                @click="deleteSelection"
              >
                删除所选
              </button>
            </div>
            <div ref="listScrollArea" class="site-list-scroll">
              <div v-if="filtered.length" class="password-list">
                <div
                  v-for="group in filtered"
                  :key="group.key"
                  class="password-list-row"
                  :class="{
                    selected: batchMode ? selectedIds.has(group.key) : selectedKey === group.key
                  }"
                >
                  <input
                    v-if="batchMode"
                    type="checkbox"
                    :aria-label="`选择 ${group.display_name}`"
                    :checked="selectedIds.has(group.key)"
                    @change="toggleSelection(group.key)"
                  />
                  <button
                    class="password-row"
                    :aria-pressed="!batchMode && selectedKey === group.key"
                    @click="batchMode ? toggleSelection(group.key) : selectGroup(group)"
                  >
                    <SiteAvatar :record="group" />
                    <span class="site-description"
                      ><strong>{{ group.display_name }}</strong
                      ><small :title="group.identity"
                        ><SiteAddress
                          :identity="group.identity"
                          :website="group.category === 'web'" /></small
                    ></span>
                    <span class="site-account">{{ group.accounts.length }} 个账号</span
                    ><UiIcon name="chevron-right" class="row-chevron" />
                  </button>
                </div>
              </div>
              <div v-else-if="!loadError" class="page-empty">
                <div class="empty-symbol"><UiIcon :name="query ? 'search' : 'key'" /></div>
                <h2>{{ query || category !== 'all' ? '没有找到匹配的密码' : '让密码各就各位' }}</h2>
                <p>
                  {{
                    query || category !== 'all'
                      ? '试试其他网站名称、网址或用户名。'
                      : '添加你的第一个账号，下次使用时就能轻松找到。'
                  }}
                </p>
                <button
                  v-if="query || category !== 'all'"
                  class="button button-outline"
                  @click="resetFilters"
                >
                  查看全部密码</button
                ><button v-else class="button button-primary" @click="openAdd()">添加密码</button>
              </div>
            </div>
            <p class="list-panel-footer"><span class="status-dot" />密码已加密保存在本机</p>
          </section>
          <PasswordDetails
            v-if="selectedGroup && (!batchMode || isWide)"
            :key="selectedGroup.key"
            :group="selectedGroup"
            @back="backToList"
            @copy="onCopy"
            @edit="openEdit"
            @delete="requestDelete([$event])"
            @add="openAdd(selectedGroup)"
          />
          <div v-else class="detail-placeholder">
            <div class="empty-symbol"><UiIcon :name="batchMode ? 'shield-check' : 'key'" /></div>
            <h2>{{ batchMode ? '管理你的密码' : '选择一个网站或应用' }}</h2>
            <p>
              {{
                batchMode
                  ? '在左侧选择需要管理的记录。'
                  : '在右侧查看账号、复制密码和管理历史版本。'
              }}
            </p>
          </div>
        </div>
        <template v-else>
          <div class="page-container" :class="{ 'checkup-container': page === 'checkup' }">
            <PasswordCheckup
              v-if="page === 'checkup'"
              :records="apps"
              :checked-at="checkedAt"
              :loading="loading"
              @refresh="runCheck"
              @select-account="selectAccount"
            />

            <template v-else>
              <div class="page-heading">
                <div>
                  <h1>设置</h1>
                  <p>按你的习惯管理本地密码库。</p>
                </div>
              </div>
              <h2 class="section-title">偏好设置</h2>
              <section class="settings-card">
                <div class="preference-row">
                  <div>
                    <strong>外观</strong>
                    <p>选择密码管理器的界面主题</p>
                  </div>
                  <select v-model="theme" aria-label="外观主题" @change="saveTheme">
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="system">跟随系统</option>
                  </select>
                </div>
                <div class="preference-row">
                  <div>
                    <strong>剪贴板保护</strong>
                    <p>复制 30 秒后自动清除，期间复制的其他内容不受影响</p>
                  </div>
                  <span class="status-label"><span />已启用</span>
                </div>
                <div class="preference-row">
                  <div>
                    <strong>关闭窗口</strong>
                    <p>{{ closePreferenceDescription }}</p>
                    <p>后台运行且密码库已解锁时，浏览器扩展可继续保存和填充密码。</p>
                  </div>
                  <button
                    class="button button-outline"
                    :disabled="closePreferenceBusy"
                    @click="resetClosePreference"
                  >
                    恢复关闭提示
                  </button>
                </div>
              </section>
              <h2 class="section-title">当前密码库</h2>
              <section class="settings-card">
                <div class="preference-row">
                  <div>
                    <strong>登录账号</strong>
                    <p>{{ vaultInfo?.username || '—' }}</p>
                  </div>
                  <span class="status-label"><span />本地 SQLite</span>
                </div>
                <div class="preference-row">
                  <div class="vault-location">
                    <strong>数据库位置</strong>
                    <p class="vault-file-path">
                      {{ vaultInfo?.dbPath || vaultInfoError || '正在读取…' }}
                    </p>
                    <p>更新界面会继续使用此账号的密码库。建议定期导出加密备份。</p>
                  </div>
                  <button
                    class="button button-outline"
                    :disabled="!vaultInfo"
                    @click="openVaultFolder"
                  >
                    打开文件夹
                  </button>
                </div>
              </section>
              <h2 class="section-title">密码数据</h2>
              <section class="settings-card">
                <div class="preference-row">
                  <div>
                    <strong>导入密码</strong>
                    <p>从当前密码库导出的 LocalPass 加密备份中恢复</p>
                  </div>
                  <button class="button button-outline" :disabled="backupBusy" @click="importVault">
                    选择文件
                  </button>
                </div>
                <div class="preference-row">
                  <div>
                    <strong>导出密码</strong>
                    <p>保存一份加密备份，妥善保管你的密码</p>
                  </div>
                  <button class="button button-outline" :disabled="backupBusy" @click="exportVault">
                    导出备份
                  </button>
                </div>
              </section>
              <h2 class="section-title">在浏览器中使用</h2>
              <section class="settings-card extension-card">
                <span class="extension-icon" aria-hidden="true">◎</span>
                <div>
                  <h3>与 LocalPass 浏览器扩展配合使用</h3>
                  <p>解锁密码库后，扩展可以保存登录信息，并在网站登录时提供账号选择。</p>
                  <details>
                    <summary>如何安装扩展</summary>
                    <ol>
                      <li>在 Chrome 地址栏输入 chrome://extensions。</li>
                      <li>打开「开发者模式」，选择「加载已解压的扩展程序」。</li>
                      <li>点击下方「打开扩展目录」，选择打开的 chrome-extension 文件夹。</li>
                      <li>保持 LocalPass 已解锁，然后打开网站登录页。</li>
                    </ol>
                  </details>
                  <button class="button button-outline" @click="openExtensionFolder">
                    打开扩展目录
                  </button>
                </div>
              </section>
              <h2 class="section-title">版本与更新</h2>
              <AppUpdate settings />
              <p class="page-footnote">
                <span aria-hidden="true">◈</span>LocalPass · 本地密码管理器
              </p>
            </template>
          </div>
        </template>
      </main>
    </div>

    <AddEditModal
      v-if="modalVisible"
      :editing="editingItem"
      :defaults="addDefaults"
      @close="modalVisible = false"
      @saved="onSaved"
    />
    <VaultDialog
      v-if="pendingDelete"
      title="删除保存的密码？"
      :busy="deleting"
      @close="pendingDelete = null"
    >
      <div class="dialog-body">
        <p>
          即将删除
          {{ pendingDelete.length }}
          个账号及其全部历史版本。此操作无法撤销，网站上的账号不会受影响。
        </p>
        <p class="delete-preview">
          {{
            pendingDelete
              .slice(0, 3)
              .map((account) => `${account.display_name} · ${account.username || '未填写用户名'}`)
              .join('、')
          }}{{ pendingDelete.length > 3 ? '…' : '' }}
        </p>
        <p v-if="deleteError" class="form-err" role="alert">{{ deleteError }}</p>
      </div>
      <footer class="dialog-actions">
        <button class="button button-subtle" :disabled="deleting" @click="pendingDelete = null">
          取消</button
        ><button class="button button-danger" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? '删除中…' : '删除' }}
        </button>
      </footer>
    </VaultDialog>
    <Transition name="toast"
      ><div v-if="toast" class="manager-toast" :class="toast.type" role="status">
        {{ toast.message }}
      </div></Transition
    >
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import SiteAvatar from './SiteAvatar.vue'
import SiteAddress from './SiteAddress.vue'
import AddEditModal from './AddEditModal.vue'
import PasswordDetails from './PasswordDetails.vue'
import VaultDialog from './VaultDialog.vue'
import AppUpdate from './AppUpdate.vue'
import PasswordCheckup from './PasswordCheckup.vue'
import { filterGroups, groupAccounts, groupKey, recordId } from '../utils/vault'

const navigation = [
  { id: 'passwords', label: '密码', icon: 'key' },
  { id: 'checkup', label: '密码检查', icon: 'shield-check' },
  { id: 'settings', label: '设置', icon: 'settings' }
]
const categories = [
  { id: 'all', label: '全部' },
  { id: 'web', label: '网站' },
  { id: 'app', label: '应用' }
]
const apps = ref([])
const page = ref('passwords')
const query = ref('')
const category = ref('all')
const sort = ref('name')
const selectedKey = ref(null)
const searchInput = ref(null)
const mainContent = ref(null)
const listScrollArea = ref(null)
const listPanel = ref(null)
const wideLayout = window.matchMedia('(min-width: 1101px)')
const isWide = ref(wideLayout.matches)
const loading = ref(true)
const loadError = ref('')
const batchMode = ref(false)
const selectedIds = ref(new Set())
const modalVisible = ref(false)
const editingItem = ref(null)
const addDefaults = ref(null)
const pendingDelete = ref(null)
const deleteError = ref('')
const deleting = ref(false)
const backupBusy = ref(false)
const vaultInfo = ref(null)
const vaultInfoError = ref('')
const closePreference = ref(null)
const closePreferenceBusy = ref(false)
const closePreferenceDescription = computed(() => {
  const preference = closePreference.value
  if (!preference || preference.expiresAt <= Date.now())
    return '每次关闭时询问：取消、确认关闭或后台运行'
  const action = preference.action === 'background' ? '后台运行' : '确认关闭'
  return `关闭时自动选择「${action}」，${new Date(preference.expiresAt).toLocaleString('zh-CN', { hour12: false })} 后重新提示`
})
const locking = ref(false)
const toast = ref(null)
const checkedAt = ref('')
const savedTheme = localStorage.getItem('localpass-theme')
const theme = ref(['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'light')
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
let refreshToken = 0
let stopRefreshListener
let toastTimer
let listScroll = 0
let listFocusKey = null

const groups = computed(() => groupAccounts(apps.value))
const filtered = computed(() => filterGroups(groups.value, query.value, category.value, sort.value))
const selectedGroup = computed(() => groups.value.find((group) => group.key === selectedKey.value))
const allSelected = computed(
  () =>
    filtered.value.length > 0 && filtered.value.every((group) => selectedIds.value.has(group.key))
)

watch(filtered, (current) => {
  const keys = new Set(current.map((group) => group.key))
  selectedIds.value = new Set([...selectedIds.value].filter((key) => keys.has(key)))
  syncSelection()
})

function syncSelection() {
  if (page.value !== 'passwords' || batchMode.value) return
  const current = filtered.value
  if (!current.some((group) => group.key === selectedKey.value)) {
    selectedKey.value = isWide.value ? current[0]?.key || null : null
  }
}
function onLayoutChange(event) {
  isWide.value = event.matches
  if (isWide.value) syncSelection()
}
async function refreshApps() {
  const token = ++refreshToken
  loading.value = true
  loadError.value = ''
  try {
    const records = await window.localpass.listApps()
    if (token !== refreshToken) return false
    apps.value = records
    if (selectedKey.value && !records.some((record) => groupKey(record) === selectedKey.value)) {
      selectedKey.value = null
    }
    checkedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return true
  } catch (error) {
    if (token === refreshToken) loadError.value = error.message || '密码库加载失败，请重试。'
    return false
  } finally {
    if (token === refreshToken) loading.value = false
  }
}
function navigate(destination) {
  if (destination === 'settings') void loadClosePreference()
  page.value = destination
  selectedKey.value = null
  batchMode.value = false
  selectedIds.value.clear()
  mainContent.value?.scrollTo(0, 0)
  syncSelection()
}
function onSearch() {
  if (page.value !== 'passwords') navigate('passwords')
}
function clearSearch() {
  query.value = ''
  searchInput.value?.focus()
}
function resetFilters() {
  query.value = ''
  category.value = 'all'
}
async function selectGroup(group) {
  listScroll = listScrollArea.value?.scrollTop || 0
  listFocusKey = group.key
  selectedKey.value = group.key
  if (!isWide.value) {
    await nextTick()
    mainContent.value?.querySelector('.back-button')?.focus({ preventScroll: true })
  }
}
function selectAccount(account) {
  query.value = ''
  category.value = 'all'
  page.value = 'passwords'
  batchMode.value = false
  const group = groups.value.find((item) => item.key === groupKey(account))
  if (group) selectGroup(group)
}
async function backToList() {
  selectedKey.value = null
  await nextTick()
  listScrollArea.value?.scrollTo(0, listScroll)
  const index = filtered.value.findIndex((group) => group.key === listFocusKey)
  listPanel.value?.querySelectorAll('.password-row')[index]?.focus({ preventScroll: true })
}
function toggleBatch() {
  batchMode.value = !batchMode.value
  selectedIds.value.clear()
  if (!batchMode.value) syncSelection()
}
function toggleSelection(key) {
  if (selectedIds.value.has(key)) selectedIds.value.delete(key)
  else selectedIds.value.add(key)
}
function toggleAll() {
  selectedIds.value = allSelected.value
    ? new Set()
    : new Set(filtered.value.map((group) => group.key))
}
function deleteSelection() {
  requestDelete(
    filtered.value
      .filter((group) => selectedIds.value.has(group.key))
      .flatMap((group) => group.accounts)
  )
}
function requestDelete(accounts) {
  pendingDelete.value = accounts
  deleteError.value = ''
}
async function confirmDelete() {
  if (deleting.value) return
  deleting.value = true
  deleteError.value = ''
  let deleted = 0
  try {
    for (const account of [...pendingDelete.value]) {
      await window.localpass.deleteApp(recordId(account))
      apps.value = apps.value.filter((item) => recordId(item) !== recordId(account))
      pendingDelete.value = pendingDelete.value.filter(
        (item) => recordId(item) !== recordId(account)
      )
      deleted++
    }
    pendingDelete.value = null
    showToast(`已删除 ${deleted} 个账号`)
  } catch (error) {
    deleteError.value = `${deleted ? `已删除 ${deleted} 个账号，其余未删除。` : ''}${error.message || '删除失败，请重试。'}`
  } finally {
    deleting.value = false
    if (!selectedGroup.value) selectedKey.value = null
  }
}
function openAdd(group) {
  editingItem.value = null
  addDefaults.value = group
    ? {
        display_name: group.display_name,
        identity: group.identity,
        category: group.category,
        site_name: group.site_name,
        page_title: group.page_title,
        site_url: group.site_url,
        icon_data: group.icon_data
      }
    : null
  modalVisible.value = true
}
function openEdit(account) {
  editingItem.value = account
  addDefaults.value = null
  modalVisible.value = true
}
async function onSaved(payload) {
  modalVisible.value = false
  showToast('密码已保存')
  if (await refreshApps()) {
    page.value = 'passwords'
    resetFilters()
    batchMode.value = false
    selectedIds.value.clear()
    await nextTick()
    if (payload) selectedKey.value = groupKey(payload)
  }
}
async function onCopy(value) {
  if (!value) return showToast('当前字段为空', 'error')
  try {
    await window.localpass.copyToClipboard(String(value))
    showToast('已复制，30 秒后自动清除')
  } catch (error) {
    showToast(error.message || '复制失败', 'error')
  }
}
async function importVault() {
  backupBusy.value = true
  try {
    const result = await window.localpass.importVault()
    if (!result?.canceled) {
      showToast(`已导入 ${result.imported} 个账号`)
      await refreshApps()
    }
  } catch (error) {
    showToast(error.message || '导入失败', 'error')
  } finally {
    backupBusy.value = false
  }
}
async function exportVault() {
  backupBusy.value = true
  try {
    const result = await window.localpass.exportVault()
    if (!result?.canceled) showToast('加密备份已导出')
  } catch (error) {
    showToast(error.message || '导出失败', 'error')
  } finally {
    backupBusy.value = false
  }
}
async function loadVaultInfo() {
  try {
    vaultInfo.value = await window.localpass.getVaultInfo()
  } catch (error) {
    vaultInfoError.value = error.message || '读取密码库位置失败'
  }
}
async function openVaultFolder() {
  try {
    await window.localpass.openVaultFolder()
  } catch (error) {
    showToast(error.message || '打开文件夹失败', 'error')
  }
}
async function openExtensionFolder() {
  try {
    await window.localpass.openExtensionFolder()
  } catch (error) {
    showToast(error.message || '打开扩展目录失败', 'error')
  }
}
async function loadClosePreference() {
  try {
    closePreference.value = await window.localpass.getClosePreference()
  } catch (error) {
    showToast(error.message || '读取关闭偏好失败', 'error')
  }
}
async function resetClosePreference() {
  closePreferenceBusy.value = true
  try {
    await window.localpass.resetClosePreference()
    closePreference.value = null
    showToast('已恢复，下次关闭时会重新询问')
  } catch (error) {
    showToast(error.message || '恢复关闭提示失败', 'error')
  } finally {
    closePreferenceBusy.value = false
  }
}
async function runCheck() {
  if (await refreshApps()) showToast('密码检查已完成')
}
function applyTheme() {
  document.documentElement.dataset.theme =
    theme.value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme.value
}
function saveTheme() {
  localStorage.setItem('localpass-theme', theme.value)
  applyTheme()
}
async function lock() {
  locking.value = true
  try {
    await window.localpass.clearMasterKey()
    apps.value = []
    location.reload()
  } catch (error) {
    showToast(error.message || '锁定失败', 'error')
    locking.value = false
  }
}
function showToast(message, type = 'success') {
  clearTimeout(toastTimer)
  toast.value = { message, type }
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 3200)
}
function onKeydown(event) {
  if (document.querySelector('dialog[open]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchInput.value?.focus()
  }
  if (event.key === 'Escape' && selectedKey.value) backToList()
}
onMounted(() => {
  applyTheme()
  refreshApps()
  loadVaultInfo()
  loadClosePreference()
  window.addEventListener('focus', loadClosePreference)
  document.addEventListener('keydown', onKeydown)
  systemTheme.addEventListener('change', applyTheme)
  wideLayout.addEventListener('change', onLayoutChange)
  stopRefreshListener = window.localpass.onRefreshList(() => {
    refreshApps()
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', loadClosePreference)
  refreshToken++
  clearTimeout(toastTimer)
  stopRefreshListener?.()
  document.removeEventListener('keydown', onKeydown)
  systemTheme.removeEventListener('change', applyTheme)
  wideLayout.removeEventListener('change', onLayoutChange)
})
</script>
