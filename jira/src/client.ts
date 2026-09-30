import type { HttpRequest, HttpResponse } from 'flint-plugin-api'

export type Deployment = 'server' | 'cloud'

export interface Connection {
  /** The Jira site, like `https://jira.example.com`. */
  url: string
  deployment: Deployment
  /** Cloud only: the account's email, paired with an API token. */
  email: string
  /** A personal access token (Server/Data Center) or an API token (Cloud). */
  token: string
}

export interface User {
  /** `name` on Server/Data Center, `accountId` on Cloud. */
  id: string
  displayName: string
}

export interface Issue {
  key: string
  summary: string
  status: string
  priority: string | null
  assignee: User | null
  reporter: User | null
  type: string
  project: string
  created: string
  /** Jira's last change time; pushing compares it to detect changes made on the server. */
  updated: string
  due: string | null
  labels: string[]
  description: string
}

export interface Transition {
  id: string
  name: string
  /** The status it leads to. */
  to: string
}

export interface Comment {
  author: string
  body: string
  created: string
}

export interface Worklog {
  author: string
  timeSpent: string
  started: string
  comment: string
}

export interface Project {
  key: string
  name: string
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>

const FIELDS = [
  'summary',
  'status',
  'priority',
  'assignee',
  'reporter',
  'issuetype',
  'project',
  'created',
  'updated',
  'duedate',
  'labels',
  'description',
]
const PAGE_SIZE = 100

type Json = Record<string, unknown>

// Cloud stores rich text as Atlassian Document Format; plain text is enough here.
const toDocument = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split(/\n{2,}/).map((paragraph) => ({
    type: 'paragraph',
    content: paragraph ? [{ type: 'text', text: paragraph }] : [],
  })),
})

function fromDocument(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const node = value as { type?: string; text?: string; content?: unknown[] }
  if (node.type === 'text') return node.text ?? ''
  const inner = (node.content ?? []).map(fromDocument).join('')
  return node.type === 'paragraph' || node.type === 'heading' ? `${inner}\n\n` : inner
}

const text = (value: unknown) => fromDocument(value).trim()

function user(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { name?: string; accountId?: string; displayName?: string }
  const id = raw.accountId ?? raw.name
  return id ? { id, displayName: raw.displayName ?? id } : null
}

const nameOf = (value: unknown) =>
  value && typeof value === 'object' ? ((value as { name?: string }).name ?? null) : null

export function parseIssue(raw: Json): Issue {
  const fields = (raw.fields ?? {}) as Json
  return {
    key: String(raw.key),
    summary: String(fields.summary ?? ''),
    status: nameOf(fields.status) ?? '',
    priority: nameOf(fields.priority),
    assignee: user(fields.assignee),
    reporter: user(fields.reporter),
    type: nameOf(fields.issuetype) ?? '',
    project: String((fields.project as { key?: string } | undefined)?.key ?? ''),
    created: String(fields.created ?? ''),
    updated: String(fields.updated ?? ''),
    due: (fields.duedate as string | null | undefined) ?? null,
    labels: (fields.labels as string[] | undefined) ?? [],
    description: text(fields.description),
  }
}

/** Jira's REST API, with the differences between Server/Data Center and Cloud hidden. */
export class JiraClient {
  constructor(
    private readonly connection: Connection,
    private readonly http: Http,
  ) {}

  private get isCloud() {
    return this.connection.deployment === 'cloud'
  }

  private get api() {
    return `${this.connection.url.replace(/\/+$/, '')}/rest/api/${this.isCloud ? 3 : 2}`
  }

  private get authorization() {
    const { email, token } = this.connection
    return this.isCloud ? `Basic ${btoa(`${email}:${token}`)}` : `Bearer ${token}`
  }

  /** Links an issue on the Jira site. */
  browseUrl(key: string) {
    return `${this.connection.url.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.http({
      url: `${this.api}${path}`,
      method,
      headers: {
        Authorization: this.authorization,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Jira answered ${response.status}: ${errorMessage(response.body)}`)
    }
    return (response.body ? JSON.parse(response.body) : null) as T
  }

  myself() {
    return this.request<Json>('GET', '/myself').then(user)
  }

  /** Every issue matching `jql`, following Jira's pages. */
  async search(jql: string, limit = 500): Promise<Issue[]> {
    const issues: Issue[] = []
    const fields = FIELDS.join(',')
    let startAt = 0
    let nextPageToken: string | undefined
    while (issues.length < limit) {
      const query = new URLSearchParams({ jql, fields, maxResults: String(PAGE_SIZE) })
      if (this.isCloud && nextPageToken) query.set('nextPageToken', nextPageToken)
      if (!this.isCloud) query.set('startAt', String(startAt))
      const page = await this.request<{
        issues: Json[]
        total?: number
        nextPageToken?: string
        isLast?: boolean
      }>('GET', `${this.isCloud ? '/search/jql' : '/search'}?${query}`)
      issues.push(...page.issues.map(parseIssue))
      startAt += page.issues.length
      nextPageToken = page.nextPageToken
      const isDone = this.isCloud
        ? page.isLast !== false || !nextPageToken
        : !page.issues.length || startAt >= (page.total ?? 0)
      if (isDone) break
    }
    return issues.slice(0, limit)
  }

  issue(key: string) {
    return this.request<Json>(
      'GET',
      `/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`,
    ).then(parseIssue)
  }

  async transitions(key: string): Promise<Transition[]> {
    const result = await this.request<{ transitions: Json[] }>(
      'GET',
      `/issue/${encodeURIComponent(key)}/transitions`,
    )
    return result.transitions.map((raw) => ({
      id: String(raw.id),
      name: String(raw.name),
      to: nameOf(raw.to) ?? String(raw.name),
    }))
  }

  transition(key: string, id: string) {
    return this.request('POST', `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id },
    })
  }

  /** The value Jira expects for a user field. */
  userField(user: User) {
    return this.isCloud ? { accountId: user.id } : { name: user.id }
  }

  updateFields(key: string, fields: Json) {
    return this.request('PUT', `/issue/${encodeURIComponent(key)}`, { fields })
  }

  async createIssue(fields: {
    project: string
    type: string
    summary: string
    description: string
    priority: string | null
    assignee: User | null
  }): Promise<string> {
    const created = await this.request<{ key: string }>('POST', '/issue', {
      fields: {
        project: { key: fields.project },
        issuetype: { name: fields.type },
        summary: fields.summary,
        ...(fields.description
          ? { description: this.isCloud ? toDocument(fields.description) : fields.description }
          : {}),
        ...(fields.priority ? { priority: { name: fields.priority } } : {}),
        ...(fields.assignee ? { assignee: this.userField(fields.assignee) } : {}),
      },
    })
    return created.key
  }

  async projects(): Promise<Project[]> {
    const projects = await this.request<Json[]>('GET', '/project')
    return projects.map((raw) => ({ key: String(raw.key), name: String(raw.name) }))
  }

  async issueTypes(project: string): Promise<string[]> {
    const details = await this.request<{ issueTypes?: Json[] }>(
      'GET',
      `/project/${encodeURIComponent(project)}`,
    )
    return (details.issueTypes ?? [])
      .filter((type) => type.subtask !== true)
      .map((type) => String(type.name))
  }

  async priorities(): Promise<string[]> {
    const priorities = await this.request<Json[]>('GET', '/priority')
    return priorities.map((raw) => String(raw.name))
  }

  /** People who can be assigned issues in `project`, matching `query`. */
  async assignableUsers(project: string, query: string): Promise<User[]> {
    const search = new URLSearchParams({ project, [this.isCloud ? 'query' : 'username']: query })
    const users = await this.request<Json[]>('GET', `/user/assignable/search?${search}`)
    return users.map(user).filter((found): found is User => found !== null)
  }

  async comments(key: string): Promise<Comment[]> {
    const result = await this.request<{ comments: Json[] }>(
      'GET',
      `/issue/${encodeURIComponent(key)}/comment`,
    )
    return result.comments.map((raw) => ({
      author: user(raw.author)?.displayName ?? '',
      body: text(raw.body),
      created: String(raw.created ?? ''),
    }))
  }

  addComment(key: string, body: string) {
    return this.request('POST', `/issue/${encodeURIComponent(key)}/comment`, {
      body: this.isCloud ? toDocument(body) : body,
    })
  }

  async worklogs(key: string): Promise<Worklog[]> {
    const result = await this.request<{ worklogs: Json[] }>(
      'GET',
      `/issue/${encodeURIComponent(key)}/worklog`,
    )
    return result.worklogs.map((raw) => ({
      author: user(raw.author)?.displayName ?? '',
      timeSpent: String(raw.timeSpent ?? ''),
      started: String(raw.started ?? ''),
      comment: text(raw.comment),
    }))
  }

  /** Logs time, like `1h 30m`, started at `started` (defaults to now). */
  addWorklog(key: string, timeSpent: string, comment: string, started = new Date()) {
    return this.request('POST', `/issue/${encodeURIComponent(key)}/worklog`, {
      timeSpent,
      started: jiraTime(started),
      ...(comment ? { comment: this.isCloud ? toDocument(comment) : comment } : {}),
    })
  }
}

/** Jira's timestamp format: `2026-09-30T10:00:00.000+0000`. */
export function jiraTime(date: Date) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0')
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 23)
  return `${local}${sign}${pad(offset / 60)}${pad(offset % 60)}`
}

function errorMessage(body: string) {
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> }
    const messages = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})]
    if (messages.length) return messages.join(' ')
  } catch {
    // Not JSON: show the start of the body instead.
  }
  return body.slice(0, 200) || 'no details'
}
