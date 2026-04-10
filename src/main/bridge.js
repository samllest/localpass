import { createServer } from 'http'

import { createApp, findAppByIdentity, isVaultUnlocked, updateCredential } from './db.js'

let webContents = null
let server = null
const MAX_CAPTURE_BODY_BYTES = 32 * 1024

function normalizeField(value) {
  return value == null ? '' : String(value).trim()
}

export function initBridgeServer(winWebContents) {
  webContents = winWebContents

  if (server) {
    return
  }

  const port = 35320
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST' || req.url !== '/capture') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    let body = ''
    let bodyBytes = 0
    req.on('data', (chunk) => {
      bodyBytes += chunk.length
      if (bodyBytes > MAX_CAPTURE_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Payload too large' }))
        req.destroy()
        return
      }
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        if (!isVaultUnlocked()) {
          res.writeHead(423, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Vault locked' }))
          return
        }

        const payload = JSON.parse(body || '{}')
        const identity = normalizeField(payload.identity)
        const password = normalizeField(payload.password)
        const username = normalizeField(payload.username) || null
        const displayName = normalizeField(payload.display_name) || identity

        if (!identity || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid payload' }))
          return
        }

        const existing = findAppByIdentity(identity)
        let changed = false

        if (existing) {
          const result = updateCredential({
            app_id: existing.id,
            username,
            password
          })
          changed = result.updated
        } else {
          createApp({
            identity,
            display_name: displayName,
            category: 'web',
            username,
            password
          })
          changed = true
        }

        if (changed && webContents) {
          webContents.send('app:refreshList')
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, changed }))
      } catch (error) {
        console.error('[Bridge] Error saving captured data:', error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Internal error' }))
      }
    })
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Bridge Server] Listening on 127.0.0.1:${port}`)
  })
}
