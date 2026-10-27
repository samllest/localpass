/* global chrome */

// SVG/ICO support is inconsistent in createImageBitmap. An image document
// decodes them without injecting their markup into the DOM.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LP_RASTERIZE_ICON') return false
  const source = String(message.data || '')
  if (
    source.length > 768 * 1024 ||
    !/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)
  ) {
    sendResponse({ icon: '' })
    return false
  }
  const image = new Image()
  const timer = setTimeout(() => finish(''), 3000)
  let finished = false
  function finish(icon) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    image.onload = image.onerror = null
    image.src = ''
    sendResponse({ icon })
  }
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, 32, 32)
      const icon = canvas.toDataURL('image/png')
      finish(icon.length <= 24576 ? icon : '')
    } catch {
      finish('')
    }
  }
  image.onerror = () => finish('')
  image.src = source
  return true
})
