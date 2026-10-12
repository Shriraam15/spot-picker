/**
 * Copies text to the clipboard, and says whether it worked.
 *
 * `navigator.clipboard` needs a secure context and a user gesture. The app is
 * served from https://appassets.androidplatform.net inside the wrapper, so it
 * qualifies — but an older WebView, or a permission the platform denies, leaves
 * the promise rejecting. The `execCommand` path is the fallback every WebView
 * still implements, and the return value is what the UI tells the user.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // Off-screen but still selectable: a display:none node cannot be selected.
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
