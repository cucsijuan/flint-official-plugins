import type { Issue, JiraClient, User } from './client'

/** The fields a table cell can change; everything else is read-only. */
export const EDITABLE = ['summary', 'status', 'priority', 'assignee', 'due'] as const
export type Editable = (typeof EDITABLE)[number]

export const isEditable = (field: string): field is Editable =>
  (EDITABLE as readonly string[]).includes(field)

/** An issue's field as a table cell shows it. */
export function fieldText(issue: Issue, field: Editable): string {
  switch (field) {
    case 'summary':
      return issue.summary
    case 'status':
      return issue.status
    case 'priority':
      return issue.priority ?? ''
    case 'assignee':
      return issue.assignee?.displayName ?? ''
    case 'due':
      return issue.due ?? ''
  }
}

export interface PushResult {
  pushed: string[]
  /** Issues changed on the server since they were loaded; their local edits were dropped. */
  conflicts: string[]
  failed: { key: string; error: string }[]
}

type Edits = Partial<Record<Editable, string>>

/** Edits waiting to be pushed, and the issues as they were when loaded. */
export class Changes {
  readonly #loaded = new Map<string, Issue>()
  readonly #edits = new Map<string, Edits>()
  readonly #listeners = new Set<() => void>()

  onChange(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }

  /** Remembers issues as Jira returned them, the base for detecting server-side changes. */
  remember(issues: Issue[]) {
    for (const issue of issues) this.#loaded.set(issue.key, issue)
  }

  edits(key: string): Edits {
    return this.#edits.get(key) ?? {}
  }

  get count() {
    return this.#edits.size
  }

  stage(key: string, field: string, value: unknown) {
    const issue = this.#loaded.get(key)
    if (!issue || !isEditable(field)) return
    const text = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value).trim()
    const edits = { ...this.#edits.get(key) }
    if (text === fieldText(issue, field)) delete edits[field]
    else edits[field] = text
    if (Object.keys(edits).length) this.#edits.set(key, edits)
    else this.#edits.delete(key)
    this.#notify()
  }

  discard() {
    this.#edits.clear()
    this.#notify()
  }

  /** Sends every staged edit, issue by issue; the server wins when an issue changed meanwhile. */
  async push(client: JiraClient): Promise<PushResult> {
    const result: PushResult = { pushed: [], conflicts: [], failed: [] }
    for (const [key, edits] of [...this.#edits]) {
      const loaded = this.#loaded.get(key)
      try {
        const current = await client.issue(key)
        if (!loaded || current.updated !== loaded.updated) {
          this.#edits.delete(key)
          this.#loaded.set(key, current)
          result.conflicts.push(key)
          continue
        }
        await applyEdits(client, current, edits)
        this.#edits.delete(key)
        this.#loaded.set(key, await client.issue(key))
        result.pushed.push(key)
      } catch (error) {
        result.failed.push({ key, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.#notify()
    return result
  }
}

async function findUser(client: JiraClient, issue: Issue, name: string): Promise<User> {
  const wanted = name.toLowerCase()
  const users = await client.assignableUsers(issue.project, name)
  const user = users.find(
    ({ id, displayName }) => id.toLowerCase() === wanted || displayName.toLowerCase() === wanted,
  )
  if (!user) throw new Error(`Nobody named "${name}" can be assigned ${issue.key}`)
  return user
}

async function applyEdits(client: JiraClient, issue: Issue, edits: Edits) {
  const fields: Record<string, unknown> = {}
  if (edits.summary !== undefined) fields.summary = edits.summary
  if (edits.priority !== undefined) fields.priority = { name: edits.priority }
  if (edits.due !== undefined) fields.duedate = edits.due || null
  if (edits.assignee !== undefined) {
    fields.assignee = edits.assignee
      ? client.userField(await findUser(client, issue, edits.assignee))
      : null
  }
  if (Object.keys(fields).length) await client.updateFields(issue.key, fields)
  if (edits.status !== undefined) {
    const wanted = edits.status.toLowerCase()
    const transitions = await client.transitions(issue.key)
    const transition = transitions.find(
      ({ to, name }) => to.toLowerCase() === wanted || name.toLowerCase() === wanted,
    )
    if (!transition) {
      const options = transitions.map(({ to }) => to).join(', ')
      throw new Error(`${issue.key} can't move to "${edits.status}" (it can go to: ${options})`)
    }
    await client.transition(issue.key, transition.id)
  }
}
