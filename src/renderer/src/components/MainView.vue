<template>
  <div class="main-view">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="total-badge">共 {{ apps.length }} 条</span>
      </div>
      <nav class="sidebar-nav">
        <button
          class="nav-item"
          :class="{ active: filter === 'all' }"
          @click="filter = 'all'"
        >🗃️ 全部账号</button>
        <button
          class="nav-item"
          :class="{ active: filter === 'web' }"
          @click="filter = 'web'"
        >🌐 网页账号</button>
        <button
          class="nav-item"
          :class="{ active: filter === 'app' }"
          @click="filter = 'app'"
        >🖥️ 应用账号</button>
      </nav>
      <div class="sidebar-footer">
        <button class="btn-lock" @click="lock">🔒 锁定</button>
      </div>
    </aside>

    <!-- 主内容区 -->
    <main class="content-area">
      <!-- 顶部工具栏 -->
      <div class="toolbar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索编号、名称或域名…"
            @input="onSearch"
          />
          <button v-if="searchQuery" class="search-clear" @click="clearSearch">✕</button>
        </div>
        <button class="btn-add" @click="openAdd">＋ 新增账号</button>
      </div>

      <!-- 空状态 -->
      <div v-if="filtered.length === 0" class="empty-state">
        <div class="empty-icon">🗝️</div>
        <p>{{ searchQuery ? '没有找到匹配的账号' : '还没有保存任何账号，点击右上角新增' }}</p>
      </div>

      <!-- 卡片列表 -->
      <div v-else class="cards-grid">
        <PasswordCard
          v-for="item in filtered"
          :key="item.id"
          :item="item"
          @edit="openEdit"
          @delete="onDelete"
          @copy="onCopy"
        />
      </div>
    </main>

    <!-- 新增/编辑弹窗 -->
    <AddEditModal
      v-if="modalVisible"
      :editing="editingItem"
      @close="modalVisible = false"
      @saved="onSaved"
    />

    <!-- Toast 提示 -->
    <transition name="toast">
      <div v-if="toast.visible" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import PasswordCard from './PasswordCard.vue'
import AddEditModal from './AddEditModal.vue'

const apps = ref([])
const searchQuery = ref('')
const filter = ref('all')
const modalVisible = ref(false)
const editingItem = ref(null)
const toast = ref({ visible: false, msg: '', type: 'success' })

const filtered = computed(() => {
  return apps.value.filter((a) => {
    if (filter.value !== 'all' && a.category !== filter.value) return false
    return true
  })
})

async function load() {
  apps.value = await window.localpass.listApps()
}

async function onSearch() {
  if (!searchQuery.value.trim()) {
    apps.value = await window.localpass.listApps()
  } else {
    apps.value = await window.localpass.searchApps(searchQuery.value)
  }
}

function clearSearch() {
  searchQuery.value = ''
  load()
}

function openAdd() {
  editingItem.value = null
  modalVisible.value = true
}

function openEdit(item) {
  editingItem.value = item
  modalVisible.value = true
}

async function onDelete(id) {
  await window.localpass.deleteApp(id)
  showToast('已删除', 'error')
  load()
}

async function onCopy(text) {
  await window.localpass.copyToClipboard(text)
  showToast('已复制！30 秒后自动清除剪贴板', 'success')
}

function onSaved() {
  modalVisible.value = false
  showToast('保存成功', 'success')
  load()
}

async function lock() {
  await window.localpass.clearMasterKey()
  location.reload()
}

function showToast(msg, type = 'success') {
  toast.value = { visible: true, msg, type }
  setTimeout(() => (toast.value.visible = false), 2500)
}

onMounted(() => {
  load()
  window.localpass.onRefreshList(() => {
    load()
    showToast('已录入一条新数据（来白网页自动捕获）', 'success')
  })
})
</script>
