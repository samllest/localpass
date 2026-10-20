<template>
  <div class="unlock-wrap">
    <div class="unlock-card">
      <div class="unlock-logo"><UiIcon name="logo-lock" class="unlock-logo-icon" /></div>
      <h1 class="unlock-title">{{ isRegister ? '创建密码库' : '解锁密码库' }}</h1>
      <p class="unlock-sub">
        {{ isRegister ? '本地加密保存，主密码仅由你掌握' : '输入主密码以解锁本地密码库' }}
      </p>

      <form class="unlock-form" @submit.prevent="submit">
        <!-- 用户名输入 -->
        <div class="input-group" :class="{ error: errMsg && !username }">
          <input
            id="username"
            v-model="username"
            aria-label="用户名"
            type="text"
            :placeholder="isRegister ? '设置用户名' : '用户名'"
            autocomplete="username"
            autofocus
          />
          <UiIcon name="user" class="input-icon" />
        </div>

        <!-- 密码输入 -->
        <div class="input-group" :class="{ error: errMsg && !password }">
          <input
            id="master-pwd"
            v-model="password"
            aria-label="主密码"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="isRegister ? '设置主密码' : '主密码'"
            :autocomplete="isRegister ? 'new-password' : 'current-password'"
          />
          <UiIcon name="lock" class="input-icon" />
          <button
            type="button"
            class="unlock-eye"
            :aria-label="showPassword ? '隐藏主密码' : '显示主密码'"
            :aria-pressed="showPassword"
            @click="showPassword = !showPassword"
          >
            <UiIcon name="eye" />
          </button>
        </div>

        <!-- 确认密码 (仅注册可见) -->
        <div
          v-if="isRegister"
          class="input-group"
          :class="{ error: errMsg && password !== confirmPassword }"
        >
          <input
            id="confirm-pwd"
            v-model="confirmPassword"
            aria-label="确认主密码"
            type="password"
            placeholder="再次输入主密码"
            autocomplete="new-password"
          />
          <UiIcon name="lock" class="input-icon" />
        </div>

        <p v-if="errMsg" class="err-msg">{{ errMsg }}</p>

        <button type="submit" class="btn-unlock" :disabled="loading">
          <span v-if="loading" class="spinner" />
          <span v-else>{{ isRegister ? '创建并进入密码库' : '解锁' }}</span>
        </button>
      </form>

      <button class="unlock-hint" type="button" :disabled="loading" @click="toggleMode">
        {{ isRegister ? '已有密码库？返回解锁' : '还没有密码库？创建一个独立密码库' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import UiIcon from './UiIcon.vue'

const emit = defineEmits(['unlocked'])

const isRegister = ref(false)
const showPassword = ref(false)
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const errMsg = ref('')
const loading = ref(false)

function toggleMode() {
  isRegister.value = !isRegister.value
  showPassword.value = false
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
    let res
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
