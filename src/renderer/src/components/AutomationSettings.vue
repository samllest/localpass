<template>
  <section class="settings-card">
    <div class="preference-row">
      <div>
        <strong>自动备份</strong>
        <p>每小时保存完整密码库和历史，保留最近 14 份。</p>
        <p role="status">
          {{
            backup.error ||
            (backup.lastAt
              ? `最近备份：${new Date(backup.lastAt).toLocaleString()}`
              : '等待首次备份')
          }}
        </p>
      </div>
      <button class="button button-outline" @click="run(() => api.openBackupFolder())">
        查看备份
      </button>
    </div>
    <div class="preference-row">
      <div>
        <strong>自动锁定</strong>
        <p>解锁状态记住 31 天，重启后可继续填充；默认连续 3 天未操作自动锁定。</p>
        <p>桌面操作、浏览器填充和保存密码计入活跃时间，手动锁定立即生效。</p>
      </div>
      <select
        v-model="idle"
        aria-label="闲置锁定"
        @change="run(() => api.setIdleLock(Number(idle)))"
      >
        <option :value="4320">闲置 3 天</option>
        <option v-for="minutes in [5, 15, 30, 60]" :key="minutes" :value="minutes">
          闲置 {{ minutes }} 分钟
        </option>
      </select>
    </div>
    <div class="preference-row">
      <div>
        <strong>回收站</strong>
        <p>删除后保留账号和完整历史 30 天，可随时恢复。</p>
      </div>
      <button class="button button-outline" @click="openTrash">查看回收站</button>
    </div>
    <div class="preference-row">
      <div>
        <strong>Chrome / Edge 密码迁入</strong>
        <p>导入浏览器导出的 CSV，相同密码跳过，冲突保留独立账号。</p>
      </div>
      <button class="button button-outline" :disabled="busy" @click="importBrowser">
        导入 CSV
      </button>
    </div>
    <div class="preference-row">
      <div>
        <strong>修改主密码</strong>
        <p>验证原主密码，备份后重新加密全部密码及历史。</p>
      </div>
      <button class="button button-outline" @click="masterOpen = true">修改主密码</button>
    </div>
    <p v-if="message" class="form-err" role="status">{{ message }}</p>
  </section>
  <VaultDialog v-if="trashOpen" title="回收站" :busy="busy" @close="trashOpen = false">
    <div class="dialog-body">
      <p v-if="!trash.length">回收站为空。</p>
      <div v-for="record in trash" :key="record.id" class="preference-row">
        <div>
          <strong>{{ record.display_name }}</strong>
          <p>{{ record.identity }} · {{ record.deleted_at }}</p>
        </div>
        <button class="button button-outline" :disabled="busy" @click="restore(record)">
          恢复
        </button>
      </div>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
  </VaultDialog>
  <VaultDialog v-if="masterOpen" title="修改主密码" :busy="busy" @close="closeMaster">
    <form class="account-form" @submit.prevent="changeMaster">
      <div class="form-row">
        <label for="old-master">原主密码</label
        ><input
          id="old-master"
          v-model="oldPassword"
          type="password"
          autocomplete="current-password"
          required
          :disabled="busy"
        />
      </div>
      <div class="form-row">
        <label for="next-master">新主密码</label
        ><input
          id="next-master"
          v-model="nextPassword"
          type="password"
          autocomplete="new-password"
          minlength="12"
          required
          :disabled="busy"
        />
      </div>
      <div class="form-row">
        <label for="confirm-master">确认新主密码</label
        ><input
          id="confirm-master"
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          required
          :disabled="busy"
        />
      </div>
      <p v-if="message" class="form-err" role="alert">{{ message }}</p>
      <footer class="dialog-actions">
        <button class="button button-subtle" type="button" :disabled="busy" @click="closeMaster">
          取消</button
        ><button class="button button-primary" :disabled="busy">
          {{ busy ? '处理中…' : '保存主密码' }}
        </button>
      </footer>
    </form>
  </VaultDialog>
</template>
<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import VaultDialog from './VaultDialog.vue'
const emit = defineEmits(['changed'])
const api = window.localpass
const backup = ref({}),
  idle = ref(4320),
  trash = ref([]),
  trashOpen = ref(false),
  masterOpen = ref(false),
  busy = ref(false),
  message = ref('')
const oldPassword = ref(''),
  nextPassword = ref(''),
  confirmation = ref('')
let timer
async function run(action) {
  busy.value = true
  message.value = ''
  try {
    return await action()
  } catch (error) {
    message.value = error.message || '操作失败，请重试'
  } finally {
    busy.value = false
  }
}
async function load() {
  backup.value = await api.getBackupState()
  idle.value = (await api.getSecurityState()).idleLockMinutes
}
async function openTrash() {
  trash.value = (await run(() => api.listTrash())) || []
  trashOpen.value = true
}
async function restore(record) {
  const restored = await run(() => api.restoreApp(record.id))
  if (restored) {
    trash.value = trash.value.filter((item) => item.id !== record.id)
    emit('changed')
  }
}
async function importBrowser() {
  const result = await run(() => api.importBrowser())
  if (result && !result.canceled) {
    message.value = `已导入 ${result.imported} 个账号，跳过 ${result.duplicates + result.skipped} 项，${result.conflicts} 项冲突已独立保留`
    emit('changed')
  }
}
function closeMaster() {
  masterOpen.value = false
  oldPassword.value = nextPassword.value = confirmation.value = ''
  message.value = ''
}
async function changeMaster() {
  if (nextPassword.value !== confirmation.value) {
    message.value = '两次新主密码不一致'
    return
  }
  const result = await run(() => api.changeMasterPassword(oldPassword.value, nextPassword.value))
  if (result?.success) {
    closeMaster()
    message.value = '主密码已修改，密码历史已保留'
  }
}
onMounted(() => {
  void run(load)
  timer = setInterval(() => void load().catch(() => {}), 30000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  closeMaster()
})
</script>
