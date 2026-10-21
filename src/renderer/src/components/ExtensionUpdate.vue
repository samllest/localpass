<template>
  <section class="settings-card" aria-label="浏览器扩展与自动更新">
    <div class="preference-row">
      <div class="vault-location">
        <strong>浏览器扩展 {{ state.version || '' }}</strong>
        <p role="status">{{ message }}</p>
        <p>连接内网且 LocalPass 正在运行时，每 15 分钟自动下载新版，扩展随后自动重新加载。</p>
        <p v-if="state.browserVersion">浏览器最近报告的版本：{{ state.browserVersion }}</p>
      </div>
      <button
        class="button button-outline"
        :disabled="acting || state.busy"
        @click="act('checkExtensionUpdate')"
      >
        {{ state.busy || acting ? '处理中…' : '立即检查' }}
      </button>
    </div>
    <div class="preference-row">
      <div class="vault-location">
        <strong>已安装过扩展</strong>
        <p>选择浏览器当前加载的 LocalPass 文件夹，启用自动更新。只需设置一次。</p>
        <p class="vault-file-path">{{ state.folder }}</p>
        <p v-if="bound" role="status">
          目录已绑定。首次请在扩展管理页点击「重新加载」，之后会自动更新。
        </p>
        <details class="update-server">
          <summary>如何找到已有扩展目录</summary>
          <p>
            Edge 打开 edge://extensions，Chrome 打开 chrome://extensions，开启开发者模式，在
            LocalPass 的详情中查看加载路径。选择该路径对应的文件夹。
          </p>
          <p>
            浏览器提示新增权限时，请确认启用。扩展更新后会自动接管已打开的网页，保留你已经输入的内容。
          </p>
        </details>
      </div>
      <button class="button button-outline" :disabled="acting || state.busy" @click="bind">
        绑定已有扩展目录
      </button>
    </div>
    <div class="preference-row">
      <div>
        <strong>首次安装扩展</strong>
        <p>
          打开下方目录，在 Edge 或 Chrome 扩展管理页选择「加载已解压的扩展程序」，加载此文件夹。
        </p>
        <p>使用此目录安装后即可自动更新。保持密码库解锁，扩展才能保存与填写密码。</p>
      </div>
      <button
        class="button button-outline"
        :disabled="acting || state.busy"
        @click="act('openExtensionFolder')"
      >
        打开扩展目录
      </button>
    </div>
    <p v-if="error" class="update-action-error form-err" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

const state = ref({})
const acting = ref(false)
const error = ref('')
const bound = ref(false)
let timer
const message = computed(() => {
  if (state.value.error) return `更新未完成：${state.value.error}。现有扩展仍可继续使用。`
  if (state.value.busy) return '正在检查并更新扩展…'
  if (state.value.browserVersion && state.value.browserVersion !== state.value.version)
    return '新文件已就绪，等待浏览器加载。若版本一直不变，请绑定浏览器实际加载的扩展目录。'
  if (state.value.status === 'updated') return '新版文件已就绪，扩展会在空闲时自动重新加载。'
  if (state.value.status === 'current') return '扩展文件已是当前最新版本。'
  return '支持从内网下载站自动更新，无需反复下载扩展 ZIP。'
})
async function refresh() {
  try {
    state.value = await window.localpass.getExtensionUpdateState()
  } catch (cause) {
    error.value = cause.message || '无法读取扩展状态'
  }
}
async function act(method) {
  acting.value = true
  error.value = ''
  try {
    await window.localpass[method]()
    await refresh()
  } catch (cause) {
    error.value = cause.message || '操作失败，请重试'
  } finally {
    acting.value = false
  }
}
async function bind() {
  acting.value = true
  error.value = ''
  try {
    const result = await window.localpass.bindExtensionFolder()
    if (result.cancelled) return
    state.value = result
    bound.value = result.status === 'updated'
  } catch (cause) {
    error.value = cause.message || '绑定失败，请重试'
  } finally {
    acting.value = false
  }
}
onMounted(() => {
  void refresh()
  timer = setInterval(refresh, 5000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>
