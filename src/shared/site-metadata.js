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

export function safeIconData(value) {
  const icon = String(value || '')
  // Only small local raster images; no remote URLs or inline SVG in the vault UI.
  return icon.length <= 24576 &&
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
