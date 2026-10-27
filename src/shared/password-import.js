// RFC 4180 style CSV parsing, including quotes, commas and embedded newlines.
export function parseBrowserPasswords(text) {
  if (typeof text !== 'string' || text.length > 50 * 1024 * 1024) throw new Error('导入文件过大')
  const rows = []
  let row = [],
    field = '',
    quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (quoted || !field) quoted = !quoted
      else throw new Error('CSV 引号格式无效')
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field)
      field = ''
      if (c !== ',') {
        if (row.some(Boolean)) rows.push(row)
        row = []
        if (c === '\r' && text[i + 1] === '\n') i++
      }
    } else field += c
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  row.push(field)
  if (row.some(Boolean)) rows.push(row)
  const headers = (rows.shift() || []).map((value) =>
    value
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
  )
  const index = (name) => headers.indexOf(name)
  if (['url', 'username', 'password'].some((name) => index(name) < 0))
    throw new Error('请选择 Chrome 或 Edge 导出的密码 CSV')
  const records = [],
    seen = new Set()
  let skipped = 0
  for (const values of rows) {
    let url
    try {
      url = new URL(values[index('url')])
    } catch {
      skipped++
      continue
    }
    if (!['http:', 'https:'].includes(url.protocol) || !values[index('password')]) {
      skipped++
      continue
    }
    const username = values[index('username')] || ''
    const password = values[index('password')]
    const key = JSON.stringify([url.host, username, password])
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    records.push({
      identity: url.host,
      site_url: url.origin,
      display_name: values[index('name')] || url.host,
      category: 'web',
      username,
      password,
      notes: values[index('note')] || ''
    })
  }
  return { records, skipped }
}
