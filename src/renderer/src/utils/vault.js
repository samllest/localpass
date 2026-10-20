import { websiteAddress, normalizeSiteMetadata } from '../../../shared/site-metadata.js'
import { isDevelopmentSite, projectKey } from '../../../shared/project-matching.js'

const collator = new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true })

export function recordId(record) {
  return record.id ?? record.app_id
}

export function groupKey(record) {
  const key = `${record.category || 'web'}:${record.identity || record.display_name}`
  return record.category !== 'app' && isDevelopmentSite(record.identity)
    ? `${key}:project:${JSON.stringify(projectKey(record))}`
    : key
}

export function groupAccounts(records) {
  const groups = new Map()
  for (const record of records) {
    const key = groupKey(record)
    if (!groups.has(key)) groups.set(key, { ...record, key, accounts: [] })
    groups.get(key).accounts.push(record)
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      icon_data: group.accounts.find((account) => account.icon_data)?.icon_data || '',
      site_name: group.accounts.find((account) => account.site_name)?.site_name || '',
      page_title: group.accounts.find((account) => account.page_title)?.page_title || '',
      site_url: group.accounts.find((account) => account.site_url)?.site_url || '',
      accounts: group.accounts.sort((a, b) => collator.compare(a.username || '', b.username || ''))
    }))
    .sort((a, b) => collator.compare(a.display_name, b.display_name))
}

export function filterGroups(groups, query, category = 'all', sort = 'name') {
  const text = query.trim().toLocaleLowerCase()
  const filtered = groups.filter(
    (group) =>
      (category === 'all' || group.category === category) &&
      (!text ||
        [
          group.display_name,
          group.site_name,
          group.page_title,
          group.project_name,
          group.identity,
          ...group.accounts.map((account) => account.username)
        ].some((value) =>
          String(value || '')
            .toLocaleLowerCase()
            .includes(text)
        ))
  )
  return sort === 'recent'
    ? filtered.sort(
        (a, b) =>
          Math.max(...b.accounts.map((record) => timestamp(record.captured_at))) -
          Math.max(...a.accounts.map((record) => timestamp(record.captured_at)))
      )
    : filtered
}

export function timestamp(value) {
  if (!value) return 0
  // SQLite CURRENT_TIMESTAMP is UTC, even though its string has no timezone suffix.
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value
  return new Date(date).getTime() || 0
}

export function formatDate(value) {
  const time = timestamp(value)
  return time
    ? new Date(time).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '暂无记录'
}

export function passwordStrength(value = '') {
  const password = String(value)
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password)
  ).length
  const predictable =
    /^(.)\1+$/u.test(password) || /^(password|qwerty|123456|abcdef|admin|letmein)/i.test(password)
  const strong =
    !predictable &&
    ((password.length >= 12 && classes >= 3) || (password.length >= 20 && classes >= 2))
  if (strong) return { level: 'strong', label: '强', percent: 100 }
  if (!predictable && password.length >= 10 && classes >= 2)
    return { level: 'fair', label: '一般', percent: 60 }
  return { level: 'weak', label: '弱', percent: 25 }
}

export function checkPasswords(records) {
  const credentials = records.filter((record) => record.password)
  const counts = new Map()
  for (const record of credentials)
    counts.set(record.password, (counts.get(record.password) || 0) + 1)
  const weak = credentials.filter((record) => passwordStrength(record.password).level !== 'strong')
  const reused = credentials.filter((record) => counts.get(record.password) > 1)
  return {
    total: credentials.length,
    weak,
    reused,
    affected: new Set([...weak, ...reused].map(recordId)).size
  }
}

export function websiteUrl(identity) {
  return websiteAddress(identity)?.href || null
}

export function recordWebsiteUrl(record) {
  return normalizeSiteMetadata(record, record.identity).site_url || websiteUrl(record.identity)
}

function randomIndex(max) {
  const buffer = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / max) * max
  do {
    globalThis.crypto.getRandomValues(buffer)
  } while (buffer[0] >= limit)
  return buffer[0] % max
}

export function generatePassword(length = 20) {
  if (!Number.isInteger(length) || length < 12 || length > 128)
    throw new Error('密码长度需为 12–128 位')
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%^&*-_+=?']
  const alphabet = sets.join('')
  const chars = sets.map((set) => set[randomIndex(set.length)])
  while (chars.length < length) chars.push(alphabet[randomIndex(alphabet.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
