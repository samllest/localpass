import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { authorizeBridgeRequest } from './bridge-auth.js'

import {
  createApp,
  getVaultRevision,
  isVaultUnlocked,
  listMissingSiteIcons,
  fillMissingSiteIcon,
  listCredentialsByIdentity,
  updateApp
} from './db.js'
import { capturedSite } from '../shared/site-metadata.js'
import { projectKey, projectName, isDevelopmentSite } from '../shared/project-matching.js'
import { resolveProjectLookup, resolveProjectCapture } from './project-resolution.js'
import { UNLOCK_DURATION_MS } from './unlock-session.js'

let webContents = null
let server = null
let startPromise = null
let chooseProject = async () => null
const selections = new Map()
const pendingLookups = new Map()
const MAX_CAPTURE_BODY_BYTES = 64 * 1024

function normalizeField(value) {
  return value == null ? '' : String(value).trim()
}

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function initBridgeServer(
  winWebContents,
  { port = 35320, chooseAccount, extensionStatus, secret, beforeAccess, onActivity } = {}
) {
  webContents = winWebContents
  chooseProject = chooseAccount || (async () => null)

  if (server) {
    return startPromise
  }

  const instanceId = randomUUID()
  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const origin = req.headers.origin
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
        return sendJson(res, 403, { ok: false, error: 'Untrusted origin' })
      res.writeHead(204)
      res.end()
      return
    }

    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    if (!authorizeBridgeRequest(req, secret))
      return sendJson(res, 401, { ok: false, error: 'Untrusted browser connection' })
    beforeAccess?.()

    if (req.method === 'GET' && requestUrl.pathname === '/site-icons') {
      if (!isVaultUnlocked()) return sendJson(res, 423, { ok: false, sites: [] })
      return sendJson(res, 200, {
        ok: true,
        revision: `${instanceId}:${getVaultRevision()}`,
        sites: listMissingSiteIcons().map((row) => ({
          id: row.id,
          identity: row.identity,
          project_name: projectName(row),
          site_url: row.site_url || capturedSite(row).site_url
        }))
      })
    }

    if (req.method === 'GET' && requestUrl.pathname === '/extension-status') {
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, {
        ...(extensionStatus?.(requestUrl.searchParams.get('version')) || { ok: false }),
        instanceId,
        revision: `${instanceId}:${getVaultRevision()}`,
        unlocked: isVaultUnlocked()
      })
      return
    }

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
        const revision = getVaultRevision()
        const valid = () => isVaultUnlocked() && getVaultRevision() === revision
        const site = capturedSite({
          identity,
          site_name: requestUrl.searchParams.get('site_name'),
          page_title: requestUrl.searchParams.get('page_title'),
          project_name: requestUrl.searchParams.get('project_name')
        })
        const key = JSON.stringify([revision, site.identity, projectKey(site)])
        if (!pendingLookups.has(key)) {
          const pending = { consumers: new Set(), promise: null }
          pendingLookups.set(key, pending)
          pending.promise = Promise.resolve().then(() =>
            resolveProjectLookup(listCredentialsByIdentity(site.identity), site)
          )
          void pending.promise
            .finally(() => {
              if (pendingLookups.get(key) === pending) pendingLookups.delete(key)
            })
            .catch(() => {})
        }
        const pending = pendingLookups.get(key)
        const consumer = {}
        pending.consumers.add(consumer)
        const disconnected = () => {
          pending.consumers.delete(consumer)
          if (!pending.consumers.size && pendingLookups.get(key) === pending)
            pendingLookups.delete(key)
        }
        res.once('close', disconnected)
        const result = await pending.promise
        res.removeListener('close', disconnected)
        pending.consumers.delete(consumer)
        if (res.destroyed) return
        if (!valid()) return sendJson(res, 423, { ok: false, error: 'Vault locked', accounts: [] })
        const currentRecords = listCredentialsByIdentity(site.identity)
        const accounts = result.accounts.flatMap((chosen) => {
          const account = currentRecords.find(
            (row) => row.app_id === chosen.app_id && projectKey(row) === projectKey(chosen)
          )
          if (!account) return []
          const token = randomUUID()
          {
            for (const [key, value] of selections)
              if (value.expires < Date.now()) selections.delete(key)
            if (selections.size >= 500) selections.delete(selections.keys().next().value)
            selections.set(token, {
              id: account.app_id,
              identity: site.identity,
              project: projectKey(site),
              username: account.username || '',
              revision,
              expires: Date.now() + UNLOCK_DURATION_MS
            })
          }
          return [
            {
              id: account.app_id,
              username: account.username || '',
              password: account.password,
              displayName: account.display_name,
              projectName: isDevelopmentSite(site.identity) ? projectName(account) : '',
              selectionToken: token
            }
          ]
        })
        sendJson(res, 200, { ok: true, accounts, selected: result.selected })
      } catch (error) {
        console.error('[Bridge] Error loading credentials:', error)
        sendJson(res, 500, { ok: false, error: 'Internal error', accounts: [] })
      }
      return
    }

    const iconOnly = requestUrl.pathname === '/site-icons'
    const activityOnly = requestUrl.pathname === '/activity'
    if (
      req.method !== 'POST' ||
      (!iconOnly && !activityOnly && requestUrl.pathname !== '/capture')
    ) {
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

    req.on('end', async () => {
      try {
        beforeAccess?.()
        if (!isVaultUnlocked()) {
          sendJson(res, 423, { ok: false, error: 'Vault locked' })
          return
        }

        const payload = JSON.parse(body || '{}')
        if (activityOnly) {
          const selection = selections.get(payload.selection_token)
          if (
            !selection ||
            selection.revision !== getVaultRevision() ||
            selection.expires <= Date.now() ||
            selection.identity !== payload.identity
          )
            return sendJson(res, 409, { ok: false, error: 'Account selection expired' })
          onActivity?.()
          return sendJson(res, 200, { ok: true })
        }
        if (!iconOnly && payload.vault_revision !== `${instanceId}:${getVaultRevision()}`)
          return sendJson(res, 409, { ok: false, error: 'Vault session changed' })
        if (iconOnly) {
          if (payload.revision !== `${instanceId}:${getVaultRevision()}`)
            return sendJson(res, 409, { ok: false, error: 'Vault session changed' })
          const changed = fillMissingSiteIcon(payload)
          if (changed && webContents && !webContents.isDestroyed())
            webContents.send('app:refreshList')
          return sendJson(res, 200, { ok: true, changed })
        }
        const site = capturedSite(payload)
        const identity = site.identity
        const password = payload.password == null ? '' : String(payload.password)
        const username = normalizeField(payload.username) || null

        if (!identity || !password) {
          sendJson(res, 400, { ok: false, error: 'Invalid payload' })
          return
        }
        onActivity?.()

        const revision = getVaultRevision()
        const valid = () => isVaultUnlocked() && getVaultRevision() === revision
        const selection = selections.get(payload.selection_token)
        const selectedId =
          selection &&
          selection.revision === revision &&
          selection.expires > Date.now() &&
          selection.identity === identity &&
          selection.project === projectKey(site) &&
          selection.username === (username || '')
            ? selection.id
            : null
        const existing = await resolveProjectCapture(
          listCredentialsByIdentity(identity),
          site,
          payload,
          (options) => chooseProject(options, valid),
          selectedId
        )
        if (!valid()) return sendJson(res, 423, { ok: false, error: 'Vault locked' })
        if (existing === false)
          return sendJson(res, 200, { ok: true, changed: false, cancelled: true })
        // Re-read after an asynchronous choice: edits/deletions may happen while
        // the prompt is open, and passwords must never cross vault sessions.
        if (
          existing &&
          !listCredentialsByIdentity(identity).some((row) => row.app_id === existing.app_id)
        ) {
          return sendJson(res, 409, { ok: false, error: 'Record changed; retry login' })
        }
        let changed = false

        if (existing) {
          const result = updateApp({
            ...site,
            display_name: existing.display_name || site.display_name,
            // Keep a cached icon if the site's icon is temporarily unavailable.
            project_name: existing.project_name || site.project_name,
            icon_data: site.icon_data || existing.icon_data,
            app_id: existing.app_id,
            username:
              payload.capture_kind === 'password-change' && !username
                ? existing.username
                : username,
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

        if (changed && webContents && !webContents.isDestroyed()) {
          webContents.send('app:refreshList')
        }

        sendJson(res, 200, { ok: true, changed })
      } catch (error) {
        console.error('[Bridge] Error saving captured data:', error)
        sendJson(res, 500, { ok: false, error: 'Internal error' })
      }
    })
  })

  const listener = server
  startPromise = new Promise((resolve, reject) => {
    const onStartupError = (error) => {
      if (server === listener) {
        server = null
        startPromise = null
      }
      reject(error)
    }
    listener.once('error', onStartupError)
    listener.listen(port, '127.0.0.1', () => {
      listener.removeListener('error', onStartupError)
      listener.on('error', (error) => console.error('[Bridge] Server error:', error))
      console.log(`[Bridge Server] Listening on 127.0.0.1:${listener.address().port}`)
      resolve()
    })
  })
  return startPromise
}

export function closeBridgeServer() {
  selections.clear()
  pendingLookups.clear()
  const listener = server
  server = null
  startPromise = null
  webContents = null
  if (!listener) return Promise.resolve()
  return new Promise((resolve) => {
    listener.close(() => resolve())
    listener.closeAllConnections()
  })
}
