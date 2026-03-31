<template>
  <!-- 自定义无框窗口 -->
  <div class="app-shell">
    <!-- 标题栏 -->
    <div class="titlebar" @dblclick="maximize">
      <div class="titlebar-brand">
        <span class="brand-icon">🔐</span>
        <span class="brand-name">LocalPass</span>
      </div>
      <div class="titlebar-spacer" style="-webkit-app-region:drag; flex:1" />
      <div class="titlebar-controls">
        <button class="wc-btn minimize" @click="minimize" title="最小化">─</button>
        <button class="wc-btn maximize" @click="maximize" title="最大化 / 还原">⬜</button>
        <button class="wc-btn close" @click="closeApp" title="关闭">✕</button>
      </div>
    </div>

    <!-- 解锁页 -->
    <UnlockScreen v-if="!unlocked" @unlocked="onUnlocked" />

    <!-- 主页 -->
    <MainView v-else />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import UnlockScreen from './components/UnlockScreen.vue'
import MainView from './components/MainView.vue'

const unlocked = ref(false)

function onUnlocked() {
  unlocked.value = true
}

function minimize() { window.localpass.minimize() }
function maximize() { window.localpass.maximize() }
function closeApp() { window.localpass.close() }
</script>
