<template>
  <section
    v-if="settings || showBanner"
    :class="settings ? 'settings-card update-settings' : 'update-banner'"
    aria-label="应用更新"
  >
    <div :class="settings ? 'preference-row' : 'update-banner-content'">
      <div class="update-description">
        <strong>{{
          settings ? `LocalPass ${updateState.currentVersion || ''}` : 'LocalPass 更新'
        }}</strong>
        <p role="status" :class="{ 'danger-text': updateState.status === 'error' }">
          {{ updateMessage }}
        </p>
        <progress
          v-if="updateState.status === 'downloading'"
          :value="updateState.percent"
          max="100"
          aria-label="更新下载进度"
        />
        <p v-if="settings">覆盖安装会保留本地密码库，安装期间浏览器连接会暂时中断。</p>
      </div>
      <div class="update-actions">
        <button
          v-if="updateState.status === 'downloaded'"
          class="button button-primary"
          :disabled="acting"
          @click="act('installUpdate')"
        >
          重启并安装
        </button>
        <button
          v-else-if="canDownload"
          class="button button-primary"
          :disabled="acting"
          @click="act('downloadUpdate')"
        >
          {{ updateState.status === 'error' ? '重新下载' : '下载更新' }}
        </button>
        <button
          v-else
          class="button button-outline"
          :disabled="updateBusy || acting || updateState.status === 'unsupported'"
          @click="act('checkForUpdates')"
        >
          {{
            updateState.status === 'checking'
              ? '检查中…'
              : updateState.status === 'downloading'
                ? '下载中…'
                : '检查更新'
          }}
        </button>
        <button
          v-if="!settings"
          class="button button-subtle"
          aria-label="稍后处理更新"
          @click="dismissedVersion = updateState.version"
        >
          稍后
        </button>
      </div>
    </div>
    <div v-if="settings" class="preference-row">
      <details class="update-server">
        <summary>内网更新地址</summary>
        <form @submit.prevent="saveServer">
          <label for="update-server-url">管理员提供的下载站地址</label>
          <input
            id="update-server-url"
            v-model="serverUrl"
            type="url"
            required
            placeholder="http://192.168.3.145:18770/"
            :disabled="updateBusy || updateState.status === 'downloaded'"
          />
          <button
            class="button button-outline"
            :disabled="updateBusy || acting || updateState.status === 'downloaded'"
          >
            保存地址
          </button>
        </form>
      </details>
    </div>
    <p v-if="actionError" class="update-action-error form-err" role="alert">{{ actionError }}</p>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { updateState, updateBusy, updateMessage, runUpdateAction } from '../utils/updates'

defineProps({ settings: Boolean })
const dismissedVersion = ref(null)
const acting = ref(false)
const actionError = ref('')
const serverUrl = ref(updateState.serverUrl)
watch(
  () => updateState.serverUrl,
  (url) => {
    serverUrl.value = url
  }
)
const canDownload = computed(
  () => updateState.version && ['available', 'error'].includes(updateState.status)
)
const showBanner = computed(
  () =>
    updateState.version &&
    dismissedVersion.value !== updateState.version &&
    ['available', 'downloading', 'downloaded', 'error'].includes(updateState.status)
)
async function act(action, value) {
  acting.value = true
  actionError.value = ''
  try {
    await runUpdateAction(action, value)
  } catch (error) {
    actionError.value = error.message
  } finally {
    acting.value = false
  }
}
async function saveServer() {
  await act('setUpdateServer', serverUrl.value)
  if (!actionError.value) await act('checkForUpdates')
}
</script>

<style scoped>
.update-banner {
  position: absolute;
  z-index: 50;
  inset: 0 0 auto;
  height: 56px;
  background: var(--accent-soft);
  border: 1px solid #d4e0ff;
  padding: 8px 24px;
  font-size: 12px;
}
.update-banner-content,
.update-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.update-banner-content {
  justify-content: space-between;
}
.update-description {
  min-width: 0;
}
.update-description p {
  font-size: 12px;
  line-height: 17px;
  color: var(--text-3);
  margin-top: 3px;
}
.update-actions {
  flex-shrink: 0;
}
progress {
  display: block;
  width: 320px;
  max-width: 100%;
  height: 3px;
  appearance: none;
  border: 0;
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
  accent-color: var(--accent);
}
progress::-webkit-progress-bar {
  background: var(--bg-3);
}
progress::-webkit-progress-value {
  background: var(--accent);
}
.update-banner .button {
  min-height: 32px;
  padding: 0 16px;
  font-size: 12px;
}
.update-banner .button-subtle {
  padding-inline: 0;
}
.update-banner .update-description strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  line-height: 17px;
}
.update-banner .update-description p {
  margin-top: 0;
  color: var(--text-1);
  font-weight: 500;
  line-height: 17px;
}

.update-server {
  width: 100%;
  font-size: 12px;
}
.update-settings > .preference-row:first-child {
  min-height: 93px;
}
.update-settings > .preference-row:has(> .update-server) {
  min-height: 48px;
  padding: 14px 20px;
}
.update-server summary {
  font-size: 13px;
  line-height: 19px;
  cursor: pointer;
}
.update-server form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
  margin-bottom: 4px;
}
.update-server label {
  line-height: 17px;
  flex-basis: 100%;
  color: var(--text-2);
}
.update-server input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-1);
  user-select: text;
}
.update-action-error {
  padding: 0 var(--space-6) var(--space-4);
}
</style>
