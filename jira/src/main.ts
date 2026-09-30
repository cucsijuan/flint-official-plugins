import type { ActivatePlugin, FlintApi } from 'flint-plugin-api'
import { Changes, type PushResult } from './changes'
import { type Deployment, JiraClient } from './client'
import { createIssue, showIssue } from './dialogs'
import { renderIssues } from './views'

const TOKEN = 'token'

interface Settings {
  url: string
  deployment: Deployment
  email: string
  /** Whose issues the sidebar lists; empty means the signed-in user. */
  sidebarUser: string
  /** Saved view arrangements by JQL query. */
  views: Record<string, string>
}

const DEFAULTS: Settings = { url: '', deployment: 'server', email: '', sidebarUser: '', views: {} }

const sidebarJql = (user: string) =>
  `assignee = ${user ? JSON.stringify(user) : 'currentUser()'} AND resolution = Unresolved ORDER BY updated DESC`

const activate: ActivatePlugin = async (flint: FlintApi) => {
  if (!flint.http || !flint.secrets) {
    flint.ui.notice('The Jira plugin needs Flint 0.12 or later.')
    return
  }
  const settings: Settings = {
    ...DEFAULTS,
    ...((await flint.storage.load<Partial<Settings>>()) ?? {}),
  }
  const save = () => flint.storage.save(settings)
  const changes = new Changes()
  const refreshers = new Set<() => Promise<void>>()

  async function client() {
    const token = await flint.secrets.get(TOKEN)
    if (!settings.url || !token) {
      throw new Error('Set up the Jira connection in Settings → Plugin options → Jira.')
    }
    return new JiraClient(
      { url: settings.url, deployment: settings.deployment, email: settings.email, token },
      flint.http.request,
    )
  }

  const refreshAll = () => Promise.all([...refreshers].map((refresh) => refresh()))

  function report(result: PushResult) {
    const parts = [
      result.pushed.length && `pushed ${result.pushed.join(', ')}`,
      result.conflicts.length &&
        `kept the server's version of ${result.conflicts.join(', ')} (changed in Jira meanwhile)`,
      result.failed.length &&
        `failed: ${result.failed.map(({ key, error }) => `${key}: ${error}`).join('; ')}`,
    ].filter(Boolean)
    flint.ui.notice(parts.length ? `Jira: ${parts.join(' · ')}` : 'Jira: nothing to push')
  }

  async function push() {
    try {
      report(await changes.push(await client()))
      await refreshAll()
    } catch (error) {
      flint.ui.notice(error instanceof Error ? error.message : String(error))
    }
  }

  async function openIssue(key: string) {
    try {
      await showIssue(flint, await client(), key)
    } catch (error) {
      flint.ui.notice(error instanceof Error ? error.message : String(error))
    }
  }

  async function newIssue() {
    try {
      await createIssue(flint, await client(), () => void refreshAll())
    } catch (error) {
      flint.ui.notice(error instanceof Error ? error.message : String(error))
    }
  }

  function show(element: HTMLElement, jql: () => string, layout?: 'list') {
    const view = renderIssues(element, {
      flint,
      client,
      changes,
      jql,
      layout,
      config: settings.views[jql()],
      onConfigChange: (config) => {
        settings.views[jql()] = config
        void save()
      },
      onOpen: (key) => void openIssue(key),
      onNew: () => void newIssue(),
      onPush: push,
    })
    refreshers.add(view.refresh)
    return () => {
      refreshers.delete(view.refresh)
      view.stop()
    }
  }

  flint.markdown.registerCodeBlockProcessor('jira', (source, element) => {
    const jql = source.trim()
    if (!jql) {
      element.textContent =
        'Write a JQL query inside the jira block, like: project = ABC AND status != Done'
      return
    }
    show(element, () => jql)
  })

  flint.ui.registerSidebarTab({
    id: 'my-issues',
    name: 'Jira',
    icon: 'ticket',
    render: (element) => show(element, () => sidebarJql(settings.sidebarUser), 'list'),
  })

  flint.ui.registerSettingsTab({
    render: (element) => renderSettings(element),
  })

  flint.commands.register({
    id: 'create-issue',
    name: 'Create Jira issue',
    run: () => void newIssue(),
  })
  flint.commands.register({ id: 'push-changes', name: 'Push Jira changes', run: () => void push() })
  flint.commands.register({
    id: 'discard-changes',
    name: 'Discard unpushed Jira changes',
    run: () => changes.discard(),
  })
  flint.commands.register({
    id: 'refresh',
    name: 'Refresh Jira issues',
    run: () => void refreshAll(),
  })

  function renderSettings(element: HTMLElement) {
    const field = (label: string, input: HTMLElement, hint = '') => {
      const row = document.createElement('label')
      row.className = 'jira-setting'
      row.append(label, input)
      if (hint) row.append(Object.assign(document.createElement('small'), { textContent: hint }))
      return row
    }
    const input = (
      value: string,
      onChange: (value: string) => void,
      type = 'text',
      placeholder = '',
    ) => {
      const element = Object.assign(document.createElement('input'), { type, value, placeholder })
      element.addEventListener('change', () => onChange(element.value.trim()))
      return element
    }
    const deployment = document.createElement('select')
    deployment.append(
      new Option('Server / Data Center', 'server', false, settings.deployment === 'server'),
      new Option('Cloud', 'cloud', false, settings.deployment === 'cloud'),
    )
    const emailRow = field(
      'Email',
      input(
        settings.email,
        (value) => {
          settings.email = value
          void save()
        },
        'email',
      ),
      'Cloud only: the email of the account that owns the API token.',
    )
    emailRow.hidden = settings.deployment !== 'cloud'
    deployment.addEventListener('change', () => {
      settings.deployment = deployment.value as Deployment
      emailRow.hidden = settings.deployment !== 'cloud'
      void save()
    })
    const token = input(
      '',
      (value) => {
        if (value)
          void flint.secrets
            .set(TOKEN, value)
            .then(() => flint.ui.notice('Jira token saved in the system keychain.'))
      },
      'password',
      'Stored in the system keychain',
    )
    const test = document.createElement('button')
    test.type = 'button'
    test.textContent = 'Test connection'
    test.addEventListener('click', async () => {
      try {
        const me = await (await client()).myself()
        flint.ui.notice(`Connected to Jira as ${me?.displayName ?? 'unknown user'}.`)
      } catch (error) {
        flint.ui.notice(error instanceof Error ? error.message : String(error))
      }
    })
    element.replaceChildren(
      field(
        'Jira URL',
        input(
          settings.url,
          (value) => {
            settings.url = value
            void save()
          },
          'url',
          'https://jira.example.com',
        ),
      ),
      field('Type', deployment),
      emailRow,
      field(
        'Token',
        token,
        'A personal access token (Server/Data Center) or an API token (Cloud).',
      ),
      field(
        'Sidebar user',
        input(
          settings.sidebarUser,
          (value) => {
            settings.sidebarUser = value
            void save()
            void refreshAll()
          },
          'text',
          'You',
        ),
        'Whose open issues the Jira sidebar tab lists, by username; leave empty for yourself.',
      ),
      test,
    )
    return undefined
  }
}

export default activate
