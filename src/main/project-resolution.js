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
  if (!isDevelopmentSite(site.identity)) {
    return records.find((row) => String(row.username || '') === username) || null
  }
  if (selectedId) return records.find((row) => row.app_id === selectedId) || false
  const matches = matchProject(records, site).filter(
    (row) => String(row.username || '') === username
  )
  const candidates = matches.length
    ? matches
    : records.filter((row) => !projectName(row) && String(row.username || '') === username)
  const accounts = !projectName(site)
    ? records.filter((row) => String(row.username || '') === username)
    : candidates
  if (!accounts.length) return null
  if (matches.length === 1 && matches[0].password === payload.password) return matches[0]
  // Even one same-name account might belong to a different project reusing the
  // address. A changed password must never silently overwrite it.
  const id = await choose({
    identity: site.identity,
    project: projectName(site),
    accounts,
    saving: true
  })
  if (id === 'new') return null
  return accounts.find((row) => row.app_id === id) || false
}
