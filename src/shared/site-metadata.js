export function websiteAddress(value) {
  const raw = String(value || '').trim()
  if (!raw || /\s/.test(raw)) return null
  const explicit = /^https?:\/\//i.test(raw)
  if (!explicit && /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[^/:]+:\d+(?:\/|$)/.test(raw)) return null
  const local =
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])(:|\/|\.|\d|$)/i.test(raw)
  try {
    const url = new URL(explicit ? raw : `${local ? 'http' : 'https'}://${raw}`)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

// Chromium's 32px blank-document favicon is an HTTP 200 image, not a site icon.
// Keep this fingerprint in sync with background.js (which runs without imports).
export const DEFAULT_BROWSER_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABRElEQVR4AeyX4REBMRCFUQEdKIEO6EAJdKADOjAqMDqgAjqgAzqgA967Sdzlstxm5P6t2U1Osnn5rLncXq8jf4YYPsEf8JfSd4jjOnR6kwAocoHEBN6Ha22OQEJzPS51JgFssJQb79EP4N0Gx3Rhd7TcPAlCAphBiLZG84RrbYrAZAgJADqFUay4UDaMT4b4BaDcNwhLhsgNQJokiDYAkiDaAlBD5ADwdwpvQW5c9frfwcOqOt/JAbB1ijf00qnJcQ83QkxgOQB4XhDCZyLYoPaFB1wwlAOAgks0TacmQmLLBRArK0cMwDJgGbAMWAYsA5YBKQO+sIiKB+UTVgrzFVE0JwFcXRRf0b4udDGajj9k5QKPrv90EsACs8wCXzZZz0l1XsoY37CpRU1WTpAvTQJgJTtGyAH+t0GAG5/RU5PauCztDQAA///3JTG8AAAABklEQVQDAGm4Uc19dK5XAAAAAElFTkSuQmCC'

export function safeIconData(value) {
  const icon = String(value || '')
  // Only small local raster images; no remote URLs or inline SVG in the vault UI.
  return icon !== DEFAULT_BROWSER_ICON &&
    icon.length <= 24576 &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(icon)
    ? icon
    : ''
}

export function normalizeSiteMetadata(value, identity) {
  const url = websiteAddress(value.site_url)
  const address = websiteAddress(identity)
  return {
    site_name: String(value.site_name || '')
      .trim()
      .slice(0, 160),
    page_title: String(value.page_title || '')
      .trim()
      .slice(0, 256),
    project_name: String(value.project_name || '')
      .trim()
      .slice(0, 256),
    site_url: url && address && url.host === address.host ? url.origin : '',
    icon_data: safeIconData(value.icon_data)
  }
}

export function capturedSite(payload) {
  // page_url also recovers the port when a still-open tab runs an older extension.
  const url = websiteAddress(payload.page_url || payload.site_url || payload.identity)
  if (!url) throw new Error('Invalid website address')
  const metadata = normalizeSiteMetadata(
    {
      ...payload,
      project_name: payload.project_name || payload.site_name || payload.page_title || '',
      site_url: url.origin
    },
    url.host
  )
  return {
    identity: url.host,
    display_name:
      metadata.site_name ||
      metadata.page_title ||
      String(payload.display_name || '')
        .trim()
        .slice(0, 256) ||
      url.host,
    ...metadata
  }
}
