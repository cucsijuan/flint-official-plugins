import type { FlintApi } from 'flint-plugin-api'
import type { Issue, JiraClient, User } from './client'

type Child = Node | string

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props)
  element.append(...children)
  return element
}

/** A modal dialog removed from the page once closed. */
function openDialog(title: string, content: Child[]) {
  const close = h('button', {
    type: 'button',
    className: 'jira-close',
    textContent: '×',
    title: 'Close',
  })
  const dialog = h('dialog', { className: 'jira-dialog' }, [
    h('header', {}, [h('h2', { textContent: title }), close]),
    ...content,
  ])
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  return dialog
}

const when = (timestamp: string) => (timestamp ? new Date(timestamp).toLocaleString() : '')

function failureNotice(flint: FlintApi, error: unknown) {
  flint.ui.notice(error instanceof Error ? error.message : String(error))
}

/** An issue's details, comments and worklog, with forms to add to them. */
export async function showIssue(flint: FlintApi, client: JiraClient, key: string) {
  let issue: Issue
  try {
    issue = await client.issue(key)
  } catch (error) {
    failureNotice(flint, error)
    return
  }
  const facts = h('dl', { className: 'jira-facts' }, [
    ...[
      ['Status', issue.status],
      ['Priority', issue.priority ?? '—'],
      ['Assignee', issue.assignee?.displayName ?? 'Unassigned'],
      ['Reporter', issue.reporter?.displayName ?? '—'],
      ['Type', issue.type],
      ['Due', issue.due ?? '—'],
    ].flatMap(([term, value]) => [h('dt', { textContent: term }), h('dd', { textContent: value })]),
  ])
  const openButton = h('button', { type: 'button', textContent: 'Open in Jira' })
  openButton.addEventListener('click', () => flint.ui.openUrl(client.browseUrl(key)))
  const comments = h('div', { className: 'jira-list' })
  const worklogs = h('div', { className: 'jira-list' })

  async function loadComments() {
    const found = await client.comments(key)
    comments.replaceChildren(
      ...(found.length
        ? found.map((comment) =>
            h('article', {}, [
              h('small', { textContent: `${comment.author} · ${when(comment.created)}` }),
              h('p', { textContent: comment.body }),
            ]),
          )
        : [h('p', { className: 'jira-empty', textContent: 'No comments yet.' })]),
    )
  }

  async function loadWorklogs() {
    const found = await client.worklogs(key)
    worklogs.replaceChildren(
      ...(found.length
        ? found.map((worklog) =>
            h('article', {}, [
              h('small', { textContent: `${worklog.author} · ${when(worklog.started)}` }),
              h('p', {
                textContent: [worklog.timeSpent, worklog.comment].filter(Boolean).join(' — '),
              }),
            ]),
          )
        : [h('p', { className: 'jira-empty', textContent: 'No time logged yet.' })]),
    )
  }

  const commentText = h('textarea', { placeholder: 'Add a comment…', rows: 3 })
  const commentButton = h('button', { type: 'button', textContent: 'Comment' })
  commentButton.addEventListener('click', async () => {
    if (!commentText.value.trim()) return
    try {
      await client.addComment(key, commentText.value.trim())
      commentText.value = ''
      await loadComments()
    } catch (error) {
      failureNotice(flint, error)
    }
  })

  const timeSpent = h('input', { type: 'text', placeholder: 'Time spent, like 1h 30m' })
  const worklogComment = h('input', { type: 'text', placeholder: 'What you did (optional)' })
  const logButton = h('button', { type: 'button', textContent: 'Log time' })
  logButton.addEventListener('click', async () => {
    if (!timeSpent.value.trim()) return
    try {
      await client.addWorklog(key, timeSpent.value.trim(), worklogComment.value.trim())
      timeSpent.value = ''
      worklogComment.value = ''
      await loadWorklogs()
    } catch (error) {
      failureNotice(flint, error)
    }
  })

  openDialog(`${issue.key} · ${issue.summary}`, [
    h('div', { className: 'jira-actions' }, [openButton]),
    facts,
    ...(issue.description
      ? [h('p', { className: 'jira-description', textContent: issue.description })]
      : []),
    h('h3', { textContent: 'Comments' }),
    comments,
    h('div', { className: 'jira-form' }, [commentText, commentButton]),
    h('h3', { textContent: 'Worklog' }),
    worklogs,
    h('div', { className: 'jira-form jira-row' }, [timeSpent, worklogComment, logButton]),
  ])
  await Promise.all([loadComments(), loadWorklogs()]).catch((error: unknown) =>
    failureNotice(flint, error),
  )
}

const option = (value: string, label = value) => h('option', { value, textContent: label })

/** A form for a new issue; resolves with its key once created. */
export async function createIssue(
  flint: FlintApi,
  client: JiraClient,
  onCreated: (key: string) => void,
) {
  const project = h('select')
  const type = h('select')
  const priority = h('select')
  const summary = h('input', { type: 'text', placeholder: 'Summary' })
  const description = h('textarea', { placeholder: 'Description (optional)', rows: 5 })
  const assignee = h('input', { type: 'text', placeholder: 'Assignee name (optional)' })
  const createButton = h('button', {
    type: 'button',
    textContent: 'Create issue',
    className: 'jira-push',
  })

  try {
    const [projects, priorities] = await Promise.all([client.projects(), client.priorities()])
    project.append(...projects.map((found) => option(found.key, `${found.name} (${found.key})`)))
    priority.append(option('', 'Default priority'), ...priorities.map((name) => option(name)))
  } catch (error) {
    failureNotice(flint, error)
    return
  }

  async function loadTypes() {
    type.replaceChildren(...(await client.issueTypes(project.value)).map((name) => option(name)))
  }
  project.addEventListener(
    'change',
    () => void loadTypes().catch((error: unknown) => failureNotice(flint, error)),
  )
  await loadTypes().catch((error: unknown) => failureNotice(flint, error))

  const dialog = openDialog('New Jira issue', [
    h('div', { className: 'jira-form' }, [
      h('label', {}, ['Project', project]),
      h('label', {}, ['Type', type]),
      summary,
      description,
      h('label', {}, ['Priority', priority]),
      assignee,
      createButton,
    ]),
  ])

  createButton.addEventListener('click', async () => {
    if (!summary.value.trim()) {
      summary.focus()
      return
    }
    createButton.disabled = true
    try {
      let user: User | null = null
      if (assignee.value.trim()) {
        const wanted = assignee.value.trim().toLowerCase()
        const users = await client.assignableUsers(project.value, assignee.value.trim())
        user =
          users.find(({ id, displayName }) =>
            [id, displayName].some((name) => name.toLowerCase() === wanted),
          ) ?? null
        if (!user)
          throw new Error(
            `Nobody named "${assignee.value.trim()}" can be assigned in ${project.value}`,
          )
      }
      const key = await client.createIssue({
        project: project.value,
        type: type.value,
        summary: summary.value.trim(),
        description: description.value.trim(),
        priority: priority.value || null,
        assignee: user,
      })
      dialog.close()
      flint.ui.notice(`Created ${key}`)
      onCreated(key)
    } catch (error) {
      failureNotice(flint, error)
      createButton.disabled = false
    }
  })
}
