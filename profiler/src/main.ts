import type { ActivatePlugin } from 'flint-plugin-api'
import { isManifest, PieceSource } from './pieces'
import { memorySource, Timeline } from './timeline'
import { parseTrace } from './trace'

/** `key: value` lines of a profiler block. */
function options(source: string) {
  return Object.fromEntries(
    source
      .split('\n')
      .map((line) => line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map(([, key, value]) => [key.toLowerCase(), value.replace(/^["']|["']$/g, '')]),
  )
}

/** Stops a timeline once its element has been on the page and left it. */
function whenRemoved(element: HTMLElement, cleanup: () => void) {
  let wasShown = element.isConnected
  const observer = new MutationObserver(() => {
    if (element.isConnected) wasShown = true
    else if (wasShown) {
      observer.disconnect()
      cleanup()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

const activate: ActivatePlugin = (flint) => {
  flint.markdown.registerCodeBlockProcessor('profiler', async (source, element) => {
    const { file, frames } = options(source)
    if (!file) {
      element.textContent = 'Add the capture to show, like: file: .profiles/capture.json'
      return
    }
    element.textContent = `Loading ${file}…`
    try {
      const isFolder =
        file.endsWith('/') || file.endsWith('manifest.json') || !file.endsWith('.json')
      const folder = file.replace(/\/?(manifest\.json)?$/, '')
      const json: unknown = JSON.parse(
        await flint.vault.read(isFolder ? `${folder}/manifest.json` : file),
      )
      const source = isManifest(json)
        ? new PieceSource(json, (piece) => flint.vault.read(`${folder}/${piece}`))
        : memorySource(parseTrace(json, { frameMarker: frames }))
      const timeline = new Timeline(source)
      element.replaceChildren(timeline.element)
      whenRemoved(element, () => timeline.destroy())
    } catch (error) {
      element.textContent = `Couldn't show ${file}: ${error instanceof Error ? error.message : String(error)}`
      element.classList.add('profiler-error')
    }
  })
  return undefined
}

export default activate
