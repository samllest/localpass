<template>
  <!-- 自定义无框窗口 -->
  <div class="app-shell">
    <!-- 标题栏 -->
    <div class="titlebar" @dblclick="maximize">
      <div class="titlebar-brand">
        <UiIcon name="brand-titlebar" class="brand-mark" />
        <span class="brand-name">LocalPass</span>
      </div>
      <div class="titlebar-spacer" />
      <div class="titlebar-controls">
        <button class="wc-btn minimize" title="最小化" @click="minimize">
          <UiIcon name="win-minimize" />
        </button>
        <button class="wc-btn maximize" title="最大化 / 还原" @click="maximize">
          <UiIcon name="win-maximize" />
        </button>
        <button class="wc-btn close" title="关闭" @click="closeApp">
          <UiIcon name="win-close" />
        </button>
      </div>
    </div>

    <AppUpdate />

    <!-- 解锁页 -->
    <UnlockScreen v-if="sessionReady && !unlocked" @unlocked="onUnlocked" />

    <!-- 主页 -->
    <MainView v-else-if="unlocked" />
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import UiIcon from './components/UiIcon.vue'
import UnlockScreen from './components/UnlockScreen.vue'
import MainView from './components/MainView.vue'
import AppUpdate from './components/AppUpdate.vue'
import { initializeUpdates } from './utils/updates'

let stopUpdates
let stopLocked
let lastActivitySent = 0
function recordActivity(event) {
  if (!event.isTrusted || !unlocked.value || Date.now() - lastActivitySent < 30000) return
  lastActivitySent = Date.now()
  window.localpass.recordActivity()
}
onMounted(async () => {
  for (const type of ['pointerdown', 'keydown', 'wheel'])
    window.addEventListener(type, recordActivity, { capture: true, passive: true })
  stopLocked = window.localpass.onLocked(() => {
    unlocked.value = false
  })
  try {
    unlocked.value = (await window.localpass.getAuthSession()).unlocked
  } finally {
    sessionReady.value = true
  }
  stopUpdates = await initializeUpdates()
})
onBeforeUnmount(() => {
  for (const type of ['pointerdown', 'keydown', 'wheel'])
    window.removeEventListener(type, recordActivity, true)
  stopUpdates?.()
  stopLocked?.()
})

const savedTheme = localStorage.getItem('localpass-theme') || 'light'
document.documentElement.dataset.theme =
  savedTheme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : savedTheme

const unlocked = ref(false)
const sessionReady = ref(false)

function onUnlocked() {
  unlocked.value = true
}

function minimize() {
  window.localpass.minimize()
}
function maximize() {
  window.localpass.maximize()
}
function closeApp() {
  window.localpass.close()
}
</script>
