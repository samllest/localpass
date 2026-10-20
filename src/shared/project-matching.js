import { websiteAddress } from './site-metadata.js'

export function isDevelopmentSite(identity) {
  const host = websiteAddress(identity)?.hostname.toLowerCase() || ''
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
  return (
    /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/.test(host) ||
    /\.(localhost|local|test)$/.test(host) ||
    (ipv4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
    /^\[(fc|fd|fe80:)/.test(host)
  )
}

export function projectName(value = {}) {
  const name =
    value.project_name ||
    value.site_name ||
    value.page_title ||
    (value.display_name !== value.identity ? value.display_name : '') ||
    ''
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 256)
}

export function projectKey(value) {
  return projectName(value).toLowerCase()
}

export function matchProject(records, site) {
  if (!isDevelopmentSite(site.identity)) return records
  const key = projectKey(site)
  // Missing names cannot safely match another project on a reused port.
  return key ? records.filter((record) => projectKey(record) === key) : []
}
