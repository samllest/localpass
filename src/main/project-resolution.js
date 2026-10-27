import { isDevelopmentSite, matchProject, projectName } from '../shared/project-matching.js'

export async function resolveProjectLookup(records, site) {
  if (!isDevelopmentSite(site.identity)) return { accounts: records, selected: false }
  const matches = matchProject(records, site)
  // Keep project isolation, but let the browser picker handle every account
  // choice. Merely focusing a login field must never open a desktop window.
  const candidates = matches.length ? matches : records.filter((row) => !projectName(row))
  const accounts = !projectName(site) ? records : candidates
  return { accounts, selected: false }
}

export async function resolveProjectCapture(records, site, payload, choose, selectedId) {
  const username = String(payload.username || '').trim()
  if (selectedId) return records.find((row) => row.app_id === selectedId) || false
  const scoped = isDevelopmentSite(site.identity) ? matchProject(records, site) : records
  const matches = scoped.filter((row) => String(row.username || '') === username)
  if (payload.capture_kind === 'password-change' && payload.previous_password) {
    const previous = (username ? matches : scoped).filter(
      (row) => row.password === payload.previous_password
    )
    if (previous.length === 1) return previous[0]
  }
  const exact = matches.filter((row) => row.password === payload.password)
  return exact.length === 1 ? exact[0] : null
}
