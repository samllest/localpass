<template>
  <VaultDialog
    :title="editing ? '编辑密码' : '添加密码'"
    :class="[
      'account-dialog',
      { 'project-dialog': developmentSite, 'edit-dialog': editing, 'existing-dialog': defaults }
    ]"
    :busy="saving"
    @close="$emit('close')"
  >
    <form class="account-form" @submit.prevent="submit">
      <p class="form-intro">
        {{ editing ? '更新网站信息和登录账号' : '密码会加密保存在你的本地密码库中。' }}
      </p>
      <div v-if="editing || defaults" class="form-site-summary">
        <SiteAvatar :record="initial" />
        <div>
          <strong>{{ initial.display_name }}</strong
          ><small>{{ initial.page_title || initial.identity }}</small>
        </div>
      </div>
      <div class="form-pair">
        <div class="form-row">
          <label for="account-name">名称 <span class="required">*</span></label
          ><input
            id="account-name"
            v-model="form.display_name"
            type="text"
            placeholder="例如：Google"
            required
            autofocus
            :disabled="saving"
          />
        </div>
        <div class="form-row">
          <label for="account-category">类型</label
          ><select id="account-category" v-model="form.category" :disabled="saving">
            <option value="web">网站</option>
            <option value="app">应用</option>
          </select>
        </div>
      </div>
      <div class="form-pair identity-pair" :class="{ 'app-identity': form.category === 'app' }">
        <div class="form-row">
          <label for="account-identity"
            >{{ form.category === 'web' ? '网站地址' : '应用标识' }}
            <span class="required">*</span></label
          >
          <input
            id="account-identity"
            v-model="form.identity"
            type="text"
            :placeholder="form.category === 'web' ? '例如：accounts.google.com' : '例如：MyApp'"
            required
            :disabled="saving"
          />
        </div>
        <div v-if="form.category === 'web'" class="form-row">
          <label for="account-port">端口</label
          ><input
            id="account-port"
            v-model="form.port"
            aria-label="端口（选填）"
            type="text"
            inputmode="numeric"
            placeholder="端口（选填）"
            :disabled="saving || form.category === 'app'"
          />
        </div>
      </div>
      <div v-if="developmentSite" class="form-row">
        <label for="account-project">项目名称</label>
        <input
          id="account-project"
          v-model="form.project_name"
          type="text"
          maxlength="256"
          placeholder="与网页的网站名称或标签页标题一致"
          :disabled="saving"
        />
        <p class="field-hint">同一地址和端口按项目名称区分；名称仍相同时，填充前会让你选择账号。</p>
      </div>
      <div class="form-row">
        <label for="account-username">用户名</label
        ><input
          id="account-username"
          v-model="form.username"
          type="text"
          placeholder="邮箱或用户名（选填）"
          autocomplete="off"
          :disabled="saving"
        />
      </div>
      <div class="form-row">
        <label for="account-password">密码 <span v-if="!editing" class="required">*</span></label>
        <div class="password-input">
          <input
            id="account-password"
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="editing ? '留空保留原密码' : '输入密码'"
            :required="!editing"
            autocomplete="new-password"
            :disabled="saving"
          /><button
            type="button"
            class="icon-button"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            :aria-pressed="showPassword"
            :disabled="saving"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? '隐藏' : '显示' }}
          </button>
        </div>
        <div v-if="form.password" class="password-strength" :class="strength.level">
          <span class="strength-track"><i :style="{ width: `${strength.percent}%` }" /></span
          ><span>密码强度：{{ strength.label }}</span>
        </div>
        <p v-if="editing" class="field-hint">不修改密码时，将保留当前密码和历史记录。</p>
        <button
          type="button"
          class="text-button generate-button"
          :disabled="saving"
          @click="generate"
        >
          <span aria-hidden="true">✦</span>生成强密码</button
        ><span v-if="generated" class="field-hint" role="status">已生成 20 位随机密码</span>
      </div>
      <p v-if="error" class="form-err" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <button
          type="button"
          class="button button-subtle"
          :disabled="saving"
          @click="$emit('close')"
        >
          取消</button
        ><button type="submit" class="button button-primary" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </form>
  </VaultDialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import SiteAvatar from './SiteAvatar.vue'
import VaultDialog from './VaultDialog.vue'
import { generatePassword, passwordStrength, recordId, websiteUrl } from '../utils/vault'
import { websiteAddress, normalizeSiteMetadata } from '../../../shared/site-metadata'
import { isDevelopmentSite, projectName } from '../../../shared/project-matching'

const props = defineProps({ editing: Object, defaults: Object })
const emit = defineEmits(['close', 'saved'])
const initial = props.editing || props.defaults || {}
const initialUrl =
  initial.category !== 'app' ? websiteAddress(initial.site_url || initial.identity) : null
const form = ref({
  display_name: initial.display_name || '',
  identity: initialUrl ? `${initialUrl.protocol}//${initialUrl.hostname}` : initial.identity || '',
  port: initialUrl?.port || '',
  category: initial.category || 'web',
  project_name: projectName(initial),
  username: props.editing?.username || '',
  password: ''
})
const showPassword = ref(false)
const saving = ref(false)
const error = ref('')
const generated = ref(false)
const developmentSite = computed(
  () => form.value.category === 'web' && isDevelopmentSite(form.value.identity)
)
const strength = computed(() => passwordStrength(form.value.password))
function hidePassword() {
  showPassword.value = false
}
function generate() {
  try {
    form.value.password = generatePassword()
    generated.value = true
    showPassword.value = false
  } catch {
    error.value = '无法生成安全密码，请重试。'
  }
}
async function submit() {
  if (saving.value) return
  error.value = ''
  const display_name = form.value.display_name.trim()
  let identity = form.value.identity.trim()
  let siteUrl = ''
  if (!display_name || !identity) {
    error.value = '请填写名称和网站或应用标识。'
    return
  }
  if (form.value.category === 'web') {
    const url = websiteUrl(identity)
    if (!url) {
      error.value = '请输入有效的 http 或 https 网站地址。'
      return
    }
    const parsed = new URL(url)
    const port = form.value.port.trim()
    if (port) {
      if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) {
        error.value = '端口需为 1–65535 的数字。'
        return
      }
      parsed.port = port
    }
    identity = parsed.host
    siteUrl = parsed.origin
  }
  if (!props.editing && !form.value.password) {
    error.value = '请填写密码。'
    return
  }
  const payload = {
    ...(!props.editing && props.defaults ? normalizeSiteMetadata(props.defaults, identity) : {}),
    display_name,
    identity,
    category: form.value.category,
    username: form.value.username.trim(),
    site_url: siteUrl,
    project_name: developmentSite.value ? form.value.project_name.trim() || display_name : ''
  }
  if (form.value.password) payload.password = form.value.password
  saving.value = true
  try {
    if (props.editing)
      await window.localpass.updateApp({ ...payload, app_id: recordId(props.editing) })
    else await window.localpass.createApp(payload)
    form.value.password = ''
    emit('saved', payload)
  } catch (e) {
    error.value = `保存失败：${e.message || '请重试'}`
  } finally {
    saving.value = false
  }
}
onMounted(() => window.addEventListener('blur', hidePassword))
onBeforeUnmount(() => {
  form.value.password = ''
  window.removeEventListener('blur', hidePassword)
})
</script>
