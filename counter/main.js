/** @type {import('../../plugin-api').ActivatePlugin} */
export default function activate(flint) {
  flint.markdown.registerCodeBlockProcessor('counter', (source, element, context) => {
    const count = Number.parseInt(source, 10) || 0
    const button = Object.assign(document.createElement('button'), {
      className: 'counter-button',
      textContent: `Clicked ${count} times`,
    })
    button.addEventListener('click', () => {
      const section = context.sectionOf(element)
      if (!section) return
      // The code block's lines, without its opening and closing fences.
      void context.replaceLines(section.lineStart + 1, section.lineEnd - 1, String(count + 1))
    })
    element.append(button)
  })
}
