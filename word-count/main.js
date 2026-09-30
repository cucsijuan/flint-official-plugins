const DEFAULT_WORDS_PER_MINUTE = 200

const countWords = (text) => text.match(/\S+/g)?.length ?? 0

/** @type {import('../../plugin-api').ActivatePlugin} */
export default async function activate(flint) {
  const { EditorView } = flint.codemirror.view
  const data = {
    datesInserted: 0,
    wordsPerMinute: DEFAULT_WORDS_PER_MINUTE,
    ...(await flint.storage.load()),
  }
  let panel = null

  function render(text) {
    if (!panel) return
    const words = countWords(text)
    panel.replaceChildren(
      ...[
        ['Words', words],
        ['Characters', text.length],
        ['Reading time', `${Math.ceil(words / data.wordsPerMinute)} min`],
        ['Dates inserted', data.datesInserted],
      ].map(([label, value]) => {
        const row = document.createElement('div')
        row.className = 'word-count-row'
        row.append(label, Object.assign(document.createElement('strong'), { textContent: value }))
        return row
      }),
    )
  }

  const currentText = () => flint.editor.activeView()?.state.doc.toString() ?? ''

  flint.ui.registerSidebarTab({
    id: 'stats',
    name: 'Word count',
    icon: 'bar-chart-3',
    render(element) {
      panel = element
      render(currentText())
      return () => (panel = null)
    },
  })

  flint.ui.registerSettingsTab({
    render(element) {
      const label = document.createElement('label')
      label.className = 'word-count-setting'
      const input = Object.assign(document.createElement('input'), {
        type: 'number',
        min: 50,
        value: data.wordsPerMinute,
      })
      input.addEventListener('change', async () => {
        data.wordsPerMinute = Number(input.value) || DEFAULT_WORDS_PER_MINUTE
        await flint.storage.save(data)
        render(currentText())
      })
      label.append('Reading speed (words per minute)', input)
      element.append(label)
      return undefined
    },
  })

  flint.editor.registerExtension(
    EditorView.updateListener.of((update) => {
      if (update.docChanged) render(update.state.doc.toString())
    }),
  )

  flint.workspace.onNoteOpen(async (path) => render(path ? await flint.vault.read(path) : ''))

  flint.commands.register({
    id: 'insert-date',
    name: 'Insert current date',
    hotkey: 'Mod+Shift+D',
    isAvailable: () => flint.editor.activeView() !== null,
    async run() {
      flint.editor.replaceSelection(new Date().toISOString().slice(0, 10))
      data.datesInserted++
      await flint.storage.save(data)
      render(currentText())
    },
  })
}
