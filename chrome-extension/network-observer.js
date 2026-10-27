;(() => {
  if (globalThis.__localpassNetworkObserver) return
  globalThis.__localpassNetworkObserver = true
  function outcome(value) {
    if (!value || typeof value !== 'object') return null
    if (value.success === false || value.ok === false || value.error) return false
    if (value.success === true || value.ok === true) return true
    if (value.code !== undefined || value.status !== undefined) {
      const code = value.code ?? value.status
      if ([0, 200, '0', '200', 'success', 'ok'].includes(code)) return true
      if ([400, 401, 403, 422, 500, 'error', 'failed'].includes(code)) return false
    }
    return null
  }
  function report(url, method, status, text) {
    if (
      !['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ||
      typeof text !== 'string' ||
      text.length > 65536
    )
      return
    let result = status >= 400 ? false : null
    try {
      result ??= outcome(JSON.parse(text))
    } catch {
      /* Non-JSON responses use page confirmation. */
    }
    if (result === null) return
    window.dispatchEvent(
      new CustomEvent('localpass-auth-result', {
        detail: JSON.stringify({ url: new URL(url, location.href).href, result })
      })
    )
  }
  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args)
    const request = args[0]
    const method = args[1]?.method || request?.method || 'GET'
    const url =
      typeof request === 'string' || request instanceof URL ? String(request) : request?.url
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && url) {
      void (async () => {
        const reader = response.clone().body?.getReader()
        if (!reader) return
        const decoder = new TextDecoder()
        let text = '',
          size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > 65536) return
            text += decoder.decode(value, { stream: true })
          }
          text += decoder.decode()
          report(url, method, response.status, text)
        } finally {
          await reader.cancel().catch(() => {})
        }
      })().catch(() => {})
    }
    return response
  }
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.addEventListener(
      'load',
      () => {
        try {
          const text =
            this.responseType === 'json'
              ? JSON.stringify(this.response)
              : this.responseType === '' || this.responseType === 'text'
                ? this.responseText
                : ''
          report(String(url), method, this.status, text)
        } catch {
          /* Binary responses are ignored. */
        }
      },
      { once: true }
    )
    return originalOpen.call(this, method, url, ...args)
  }
})()
