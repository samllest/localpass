/* global chrome */

const pendingCaptures = {}

async function lookupAccounts(identity) {
  const url = new URL('http://127.0.0.1:35320/lookup')
  url.searchParams.set('identity', identity)

  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'LocalPass lookup failed')
  }
  return data.accounts || []
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LP_LOOKUP') {
    lookupAccounts(message.identity)
      .then((accounts) => sendResponse({ ok: true, accounts }))
      .catch((error) => sendResponse({ ok: false, error: error.message, accounts: [] }))
    return true
  }

  if (message.type === 'LP_LOGIN_SUBMITTED' && sender.tab) {
    pendingCaptures[sender.tab.id] = message.payload

    // Clear the pending capture after 60 seconds to prevent memory leak
    setTimeout(() => {
      delete pendingCaptures[sender.tab.id]
    }, 60000)
  }

  return false
})

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Treat any POST shortly after finding a password as a success
    if (details.method !== 'POST') return

    const tabId = details.tabId
    if (pendingCaptures[tabId]) {
      const payload = pendingCaptures[tabId]
      delete pendingCaptures[tabId]

      console.log('LocalPass: Sending HTTP request to local vault:', payload)
      fetch('http://127.0.0.1:35320/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then((res) => res.json())
        .then((data) => console.log('LocalPass MVP native HTTP response:', data))
        .catch((err) => console.error('HTTP message error (Is LocalPass Desktop running?):', err))
    }
  },
  { urls: ['<all_urls>'] }
)
