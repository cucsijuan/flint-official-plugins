import type { DataRow, DataView, DataViewOptions, FlintApi } from 'flint-plugin-api'
import { type Changes, type Editable, EDITABLE, fieldText } from './changes'
import { fieldChoices } from './choices'
import type { Issue, JiraClient } from './client'

const REFRESH_MS = 5 * 60_000
export const DEFAULT_COLUMNS = ['key', 'status', 'priority', 'assignee', 'due', 'unpushed']

const day = (timestamp: string | null) => (timestamp ? timestamp.slice(0, 10) : null)

export function issueRow(issue: Issue, changes: Changes): DataRow {
  const edits = changes.edits(issue.key)
  const value = (field: Editable) => edits[field] ?? fieldText(issue, field)
  return {
    id: issue.key,
    title: value('summary'),
    values: {
      key: issue.key,
      status: value('status'),
      priority: value('priority') || null,
      assignee: value('assignee') || null,
      due: value('due') || null,
      reporter: issue.reporter?.displayName ?? null,
      type: issue.type,
      project: issue.project,
      labels: issue.labels,
      created: day(issue.created),
      updated: day(issue.updated),
      unpushed: EDITABLE.filter((field) => field in edits),
    },
  }
}

export interface IssueViewOptions {
  flint: FlintApi
  client: () => Promise<JiraClient>
  changes: Changes
  jql: () => string
  /** The saved arrangement of this view, and where to save changes to it. */
  config: string | undefined
  onConfigChange: (config: string) => void
  layout?: DataViewOptions['layout']
  onOpen: (key: string) => void
  onNew: () => void
  onPush: () => Promise<void>
}

/** A Jira query shown with Bases' views, plus a bar to refresh and push staged edits. */
export function renderIssues(element: HTMLElement, options: IssueViewOptions) {
  const { flint, changes } = options
  element.classList.add('jira-view')
  const bar = document.createElement('div')
  bar.className = 'jira-bar'
  const status = document.createElement('span')
  status.className = 'jira-status'
  const refreshButton = button('Refresh', () => void refresh())
  const pushButton = button('Push changes', () => void options.onPush())
  pushButton.classList.add('jira-push')
  const discardButton = button('Discard', () => changes.discard())
  bar.append(status, refreshButton, discardButton, pushButton)
  const body = document.createElement('div')
  element.replaceChildren(bar, body)

  let issues: Issue[] = []
  let view: DataView | null = null
  const rows = () => issues.map((issue) => issueRow(issue, changes))

  function updateBar() {
    pushButton.textContent = changes.count ? `Push ${changes.count} changed` : 'Push changes'
    pushButton.disabled = !changes.count
    discardButton.hidden = !changes.count
  }

  async function refresh() {
    status.textContent = 'Loading…'
    try {
      const client = await options.client()
      issues = await client.search(options.jql())
      changes.remember(issues)
      status.textContent = `${issues.length} issues · updated ${new Date().toLocaleTimeString()}`
      if (view) view.update({ rows: rows() })
      else {
        view = flint.ui.renderDataView(body, {
          rows: rows(),
          columns: DEFAULT_COLUMNS,
          layout: options.layout,
          config: options.config,
          onConfigChange: options.onConfigChange,
          onOpen: options.onOpen,
          onEdit: (key, field, value) => changes.stage(key, field, value),
          choices: async (key, field, query) => {
            const issue = issues.find((known) => known.key === key)
            return issue ? fieldChoices(await options.client(), issue, field, query) : null
          },
          onNew: options.onNew,
        })
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
      status.classList.add('jira-error')
      return
    }
    status.classList.remove('jira-error')
  }

  const stopListening = changes.onChange(() => {
    updateBar()
    view?.update({ rows: rows() })
  })
  const timer = setInterval(() => {
    if (!element.isConnected && view) stop()
    else if (element.isConnected) void refresh()
  }, REFRESH_MS)

  function stop() {
    clearInterval(timer)
    stopListening()
    view?.destroy()
  }

  updateBar()
  void refresh()
  return { refresh, stop }
}

function button(label: string, onClick: () => void) {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}
