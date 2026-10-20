<template>
  <div class="password-workbench checkup-workbench" :class="{ 'has-selection': mobileDetail }">
    <section class="password-list-panel" aria-label="密码检查项目">
      <div class="list-panel-heading">
        <h2>
          总览<span>{{ report.affected }} 个账号需要留意</span>
        </h2>
        <button class="text-button batch-toggle" @click="select('overview')">总览</button>
      </div>
      <div class="list-toolbar">
        <div class="filter-chips" aria-label="检查账号类型">
          <button
            v-for="item in categories"
            :key="item.id"
            class="filter-chip"
            :class="{ active: category === item.id }"
            @click="category = item.id"
          >
            {{ item.label }}
          </button>
        </div>
        <span class="checkup-sort">本机检查</span>
      </div>
      <div class="site-list-scroll">
        <div class="password-list">
          <div
            v-for="item in checks"
            :key="item.id"
            class="password-list-row"
            :class="{
              selected: selected === item.id || (selected === 'overview' && item.id === 'weak')
            }"
          >
            <button
              class="password-row checkup-row"
              :aria-pressed="selected === item.id"
              @click="select(item.id)"
            >
              <span class="site-avatar"><UiIcon :name="item.icon" /></span>
              <span class="site-description"
                ><strong>{{ item.title }}</strong
                ><small>{{ item.subtitle }}</small></span
              >
            </button>
          </div>
        </div>
      </div>
      <p class="list-panel-footer"><span class="status-dot" />检查仅在本机进行</p>
    </section>
    <section class="password-details" aria-label="检查详情">
      <div class="detail-topline">
        <button class="text-button back-button" @click="mobileDetail = false">返回列表</button>
        <span class="detail-kind">密码检查</span>
        <button class="button button-secondary" :disabled="loading" @click="$emit('refresh')">
          <UiIcon name="shield-check" />{{ loading ? '检查中…' : '重新检查' }}
        </button>
      </div>
      <div class="detail-scroll">
        <div class="detail-title">
          <span class="site-avatar large"><UiIcon :name="current?.icon || 'shield-check'" /></span>
          <div>
            <h1>{{ selected === 'overview' ? '密码健康总览' : current.title }}</h1>
            <p>基于 {{ report.total }} 个账号的本机分析</p>
          </div>
        </div>
        <dl class="site-tab-metadata">
          <div>
            <dt>检查范围</dt>
            <dd>密码强度、重复情况与更新时间</dd>
          </div>
          <div>
            <dt>检查时间</dt>
            <dd>{{ checkedAt || '尚未检查' }}</dd>
          </div>
        </dl>
        <div class="detail-section-heading">
          <h2>{{ selected === 'overview' ? '检查项' : '相关账号' }}</h2>
          <span>{{ selected === 'overview' ? '3 项本机检查' : `${accounts.length} 个账号` }}</span>
        </div>
        <div v-if="selected === 'overview'" class="checkup-findings credential-card">
          <button
            v-for="item in checks.slice(0, 3)"
            :key="item.id"
            class="credential-field"
            @click="select(item.id)"
          >
            <span>{{ item.title }}</span
            ><strong>{{ item.count }} 个账号</strong>
          </button>
        </div>
        <div v-else-if="accounts.length" class="checkup-findings credential-card">
          <button
            v-for="account in accounts"
            :key="recordId(account)"
            class="credential-field"
            @click="$emit('select-account', account)"
          >
            <span
              ><strong>{{ account.display_name }}</strong
              ><small>{{ account.username || '未填写用户名' }}</small></span
            ><span class="checkup-view">查看账号</span>
          </button>
        </div>
        <div v-else class="checkup-empty credential-card">
          {{
            ['leaked', 'two-factor', 'score'].includes(selected)
              ? '尚未接入此项检测，无法提供检测结果。'
              : report.total
                ? '未发现此类问题。'
                : '添加密码后即可开始检查。'
          }}
        </div>
        <div class="detail-section-heading"><h2>建议</h2></div>
        <dl class="site-information">
          <div>
            <dt>优先处理</dt>
            <dd>为弱密码和重复密码设置独立的强密码</dd>
          </div>
          <div>
            <dt>检查说明</dt>
            <dd>泄露库与两步验证状态尚未检测</dd>
          </div>
        </dl>
        <footer class="credential-actions">
          <span>上次检查 {{ checkedAt || '—' }}</span
          ><button class="text-button history-toggle" :disabled="loading" @click="$emit('refresh')">
            重新检查
          </button>
        </footer>
        <p class="page-footnote">数据仅在本机分析，不会上传</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import UiIcon from './UiIcon.vue'
import { checkPasswords, recordId, timestamp } from '../utils/vault'

const props = defineProps({
  records: { type: Array, required: true },
  checkedAt: String,
  loading: Boolean
})
defineEmits(['select-account', 'refresh'])
const selected = ref('overview')
const mobileDetail = ref(false)
const category = ref('all')
const categories = [
  { id: 'all', label: '全部' },
  { id: 'web', label: '网站' },
  { id: 'app', label: '应用' }
]
const filtered = computed(() =>
  props.records.filter((r) => category.value === 'all' || r.category === category.value)
)
const report = computed(() => checkPasswords(filtered.value))
const old = computed(() =>
  filtered.value.filter(
    (r) => timestamp(r.captured_at) && Date.now() - timestamp(r.captured_at) > 90 * 86400000
  )
)
const checks = computed(() => [
  {
    id: 'weak',
    title: '弱密码',
    subtitle: `${report.value.weak.length} 个账号的密码强度不足`,
    icon: 'key',
    count: report.value.weak.length
  },
  {
    id: 'reused',
    title: '重复密码',
    subtitle: `${report.value.reused.length} 个账号的密码被重复使用`,
    icon: 'copy',
    count: report.value.reused.length
  },
  {
    id: 'old',
    title: '旧密码',
    subtitle: `${old.value.length} 个密码超过 90 天未更新`,
    icon: 'nav-recent',
    count: old.value.length
  },
  { id: 'leaked', title: '已泄露密码', subtitle: '尚未接入泄露数据库检测', icon: 'shield' },
  { id: 'two-factor', title: '两步验证', subtitle: '尚未检测账号的 2FA 状态', icon: 'lock' },
  { id: 'score', title: '安全评分', subtitle: '完整检测接入后提供', icon: 'shield-check' }
])
const current = computed(() => checks.value.find((c) => c.id === selected.value))
const accounts = computed(() =>
  selected.value === 'old' ? old.value : report.value[selected.value] || []
)
function select(id) {
  selected.value = id
  mobileDetail.value = true
}
</script>
