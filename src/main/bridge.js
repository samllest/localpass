import { createServer } from 'http'

import {
  createApp,
  findAppByIdentity,
  isVaultUnlocked,
  listCredentialsByIdentity,
  updateApp
} from './db.js'
import { capturedSite } from '../shared/site-metadata.js'

let webContents = null
let server = null
const MAX_CAPTURE_BODY_BYTES = 64 * 1024

function normalizeField(value) {
  return value == null ? '' : String(value).trim()
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function initBridgeServer(winWebContents) {
  webContents = winWebContents

  if (server) {
    return
  }

  const port = 35320
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')

    if (req.method === 'GET' && requestUrl.pathname === '/lookup') {
      if (!isVaultUnlocked()) {
        sendJson(res, 423, { ok: false, error: 'Vault locked', accounts: [] })
        return
      }

      const identity = normalizeField(requestUrl.searchParams.get('identity'))
      if (!identity) {
        sendJson(res, 400, { ok: false, error: 'Identity is required', accounts: [] })
        return
      }

      try {
        const accounts = listCredentialsByIdentity(identity).map((account) => ({
          id: account.app_id,
          username: account.username || '',
          password: account.password,
          displayName: account.display_name
        }))
        sendJson(res, 200, { ok: true, accounts })
      } catch (error) {
        console.error('[Bridge] Error loading credentials:', error)
        sendJson(res, 500, { ok: false, error: 'Internal error', accounts: [] })
      }
      return
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/capture') {
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
          sendJson(res, 423, { ok: false, error: 'Vault locked' })
          return
        }

        const payload = JSON.parse(body || '{}')
        const site = capturedSite(payload)
        const identity = site.identity
        const password = payload.password == null ? '' : String(payload.password)
        const username = normalizeField(payload.username) || null

        if (!identity || !password) {
          sendJson(res, 400, { ok: false, error: 'Invalid payload' })
          return
        }

        const existing = findAppByIdentity(identity, username)
        let changed = false

        if (existing) {
          const result = updateApp({
            ...site,
            // Keep a cached icon if the site's icon is temporarily unavailable.
            icon_data: site.icon_data || existing.icon_data,
            app_id: existing.id,
            username,
            password
          })
          changed = result.updated
        } else {
          createApp({
            ...site,
            category: 'web',
            username,
            password
          })
          changed = true
        }

        if (changed && webContents) {
          webContents.send('app:refreshList')
        }

        sendJson(res, 200, { ok: true, changed })
      } catch (error) {
        console.error('[Bridge] Error saving captured data:', error)
        sendJson(res, 500, { ok: false, error: 'Internal error' })
      }
    })
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Bridge Server] Listening on 127.0.0.1:${port}`)
  })
}
