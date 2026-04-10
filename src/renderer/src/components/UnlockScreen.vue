<template>
  <div class="unlock-wrap">
    <div class="unlock-card">
      <div class="unlock-logo">🔐</div>
      <h1 class="unlock-title">LocalPass</h1>
      <p class="unlock-sub">{{ isRegister ? '注册新的独立本地密码库' : '登录并解锁您的独立密码库' }}</p>

      <form @submit.prevent="submit" class="unlock-form">
        <!-- 用户名输入 -->
        <div class="input-group" :class="{ error: errMsg && !username }">
          <input
            id="username"
            v-model="username"
            type="text"
            placeholder="用户名 (如 example)"
            autocomplete="username"
            autofocus
          />
          <span class="input-icon">👤</span>
        </div>
        
        <!-- 密码输入 -->
        <div class="input-group" :class="{ error: errMsg && !password }">
          <input
            id="master-pwd"
            v-model="password"
            type="password"
            placeholder="主密码"
            autocomplete="current-password"
          />
          <span class="input-icon">🔑</span>
        </div>

        <!-- 确认密码 (仅注册可见) -->
        <div v-if="isRegister" class="input-group" :class="{ error: errMsg && password !== confirmPassword }">
          <input
            id="confirm-pwd"
            v-model="confirmPassword"
            type="password"
            placeholder="确认主密码"
            autocomplete="new-password"
          />
          <span class="input-icon">🔑</span>
        </div>

        <p v-if="errMsg" class="err-msg">{{ errMsg }}</p>

        <button type="submit" class="btn-unlock" :disabled="loading">
          <span v-if="loading" class="spinner" />
          <span v-else>{{ isRegister ? '注 册 并 解 锁' : '解 锁' }}</span>
        </button>
      </form>

      <p class="unlock-hint" style="cursor: pointer; text-decoration: underline;" @click="toggleMode">
        {{ isRegister ? '已有账号？点击这里登录' : '没有账号？点击注册专属密码库' }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const emit = defineEmits(['unlocked'])

const isRegister = ref(false)
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const errMsg = ref('')
const loading = ref(false)

function toggleMode() {
  isRegister.value = !isRegister.value
  errMsg.value = ''
  password.value = ''
  confirmPassword.value = ''
}

async function submit() {
  if (!username.value.trim()) {
    errMsg.value = '请输入用户名'
    return
  }
  if (!password.value.trim()) {
    errMsg.value = '主密码不能为空'
    return
  }
  if (isRegister.value && password.value !== confirmPassword.value) {
    errMsg.value = '两次输入的密码不一致'
    return
  }

  loading.value = true
  errMsg.value = ''

  try {
    let res;
    if (isRegister.value) {
      res = await window.localpass.register(username.value, password.value)
    } else {
      res = await window.localpass.login(username.value, password.value)
    }

    if (res && res.success) {
      // 成功解锁
      emit('unlocked', { username: res.username, userId: res.userId })
    } else {
      errMsg.value = res?.error || '操作失败，请检查账号密码'
    }
  } catch (e) {
    errMsg.value = e.message || '系统错误，请重试'
  } finally {
    loading.value = false
  }
}
</script>
