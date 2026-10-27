import { createHash } from 'node:crypto'

// Only SHA-1 prefixes leave this device; suffix comparison stays in this process.
export async function checkPasswordBreaches(records, request = fetch) {
  const groups = new Map()
  for (const record of records) {
    const hash = createHash('sha1')
      .update(record.password || '')
      .digest('hex')
      .toUpperCase()
    const prefix = hash.slice(0, 5)
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix).push({ id: record.id ?? record.app_id, suffix: hash.slice(5) })
  }
  const leaked = []
  for (const [prefix, candidates] of groups) {
    const response = await request(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      cache: 'no-store'
    })
    if (!response.ok) throw new Error('泄露检查服务暂不可用')
    const reader = response.body.getReader()
    let body = '',
      size = 0
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 2 * 1024 * 1024) throw new Error('泄露检查响应过大')
        body += decoder.decode(value, { stream: true })
      }
      body += decoder.decode()
    } finally {
      await reader.cancel().catch(() => {})
    }
    const hashes = new Map(body.split(/\r?\n/).map((line) => line.split(':')))
    for (const candidate of candidates)
      if (Number(hashes.get(candidate.suffix)) > 0) leaked.push(candidate.id)
  }
  return leaked
}
