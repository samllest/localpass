<template>
  <section
    v-if="settings || showBanner"
    :class="settings ? 'settings-card' : 'update-banner'"
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
        <p>需要连接公司内网；服务器地址变化时，可在此修改。</p>
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
  flex-shrink: 0;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
  padding: var(--space-3) var(--space-6);
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
  font-size: var(--font-label);
  color: var(--text-2);
  margin-top: var(--space-2);
}
.update-actions {
  flex-shrink: 0;
}
progress {
  width: 100%;
  height: var(--space-2);
  margin-top: var(--space-3);
  accent-color: var(--accent);
}
.update-server {
  width: 100%;
  font-size: var(--font-label);
}
.update-server summary {
  cursor: pointer;
}
.update-server form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.update-server label {
  flex-basis: 100%;
  color: var(--text-2);
}
.update-server input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-s);
  background: var(--bg-1);
  color: var(--text-1);
  user-select: text;
}
.update-action-error {
  padding: 0 var(--space-6) var(--space-4);
}
</style>
