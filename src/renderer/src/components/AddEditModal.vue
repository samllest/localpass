<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal-box">
      <div class="modal-header">
        <h2>{{ editing ? '编辑账号' : '新增账号' }}</h2>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>

      <form @submit.prevent="submit" class="modal-form">
        <div class="form-row">
          <label>显示名称 <span class="required">*</span></label>
          <input v-model="form.display_name" type="text" placeholder="如：Google 邮箱" required />
        </div>
        <div class="form-row">
          <label>唯一标识</label>
          <input v-model="form.identity" type="text" placeholder="如：accounts.google.com" />
        </div>
        <div class="form-row">
          <label>类别</label>
          <select v-model="form.category">
            <option value="web">🌐 网页账号</option>
            <option value="app">🖥️ 应用账号</option>
          </select>
        </div>
        <div class="form-row">
          <label>用户名</label>
          <input v-model="form.username" type="text" placeholder="用户名 / 邮箱" />
        </div>
        <div class="form-row">
          <label>密码 <span class="required">*</span></label>
          <div class="pwd-input-wrap">
            <input
              v-model="form.password"
              :type="showPwd ? 'text' : 'password'"
              placeholder="输入新密码"
              required
            />
            <button type="button" class="toggle-eye" @click="showPwd = !showPwd">
              {{ showPwd ? '🙈' : '👁️' }}
            </button>
            <button type="button" class="gen-btn" @click="generatePwd" title="随机生成强密码">⚡</button>
          </div>
          <div v-if="form.password" class="pwd-strength">
            <div class="strength-bar" :style="{ width: strength.pct + '%', background: strength.color }" />
            <span :style="{ color: strength.color }">{{ strength.label }}</span>
          </div>
        </div>

        <p v-if="errMsg" class="form-err">{{ errMsg }}</p>

        <div class="modal-footer">
          <button type="button" class="btn-cancel" @click="$emit('close')">取消</button>
          <button type="submit" class="btn-save" :disabled="saving">
            <span v-if="saving" class="spinner" />
            <span v-else>{{ editing ? '保存更改' : '创建账号' }}</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({ editing: Object })
const emit = defineEmits(['close', 'saved'])

const form = ref({
  display_name: '',
  identity: '',
  category: 'web',
  username: '',
  password: ''
})
const showPwd = ref(false)
const saving = ref(false)
const errMsg = ref('')

// 密码强度
const strength = computed(() => {
  const p = form.value.password
  if (!p) return { pct: 0, color: '#555', label: '' }
  let score = 0
  if (p.length >= 8) score++
  if (p.length >= 12) score++
  if (/[A-Z]/.test(p)) score++
  if (/[0-9]/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  const levels = [
    { pct: 20, color: '#ef4444', label: '非常弱' },
    { pct: 40, color: '#f97316', label: '弱' },
    { pct: 60, color: '#eab308', label: '一般' },
    { pct: 80, color: '#22c55e', label: '强' },
    { pct: 100, color: '#10b981', label: '非常强' }
  ]
  return levels[Math.min(score, 4)]
})

function generatePwd() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*'
  form.value.password = Array.from({ length: 18 }, () =>
    charset[Math.floor(Math.random() * charset.length)]
  ).join('')
  showPwd.value = true
}

onMounted(() => {
  if (props.editing) {
    form.value = {
      display_name: props.editing.display_name,
      identity: props.editing.identity,
      category: props.editing.category,
      username: props.editing.username || '',
      password: ''
    }
  }
})

async function submit() {
  if (!form.value.display_name.trim() || !form.value.password.trim()) {
    errMsg.value = '名称和密码为必填项'
    return
  }
  saving.value = true
  errMsg.value = ''
  try {
    if (props.editing) {
      await window.localpass.updateCredential({
        app_id: props.editing.id,
        username: form.value.username,
        password: form.value.password
      })
    } else {
      await window.localpass.createApp({
        display_name: form.value.display_name,
        identity: form.value.identity || form.value.display_name,
        category: form.value.category,
        username: form.value.username,
        password: form.value.password
      })
    }
    emit('saved')
  } catch (e) {
    errMsg.value = '保存失败：' + e.message
  } finally {
    saving.value = false
  }
}
</script>
