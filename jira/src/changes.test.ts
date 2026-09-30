import { describe, expect, it } from 'vitest'
import { Changes } from './changes'
import type { Issue, JiraClient } from './client'

const issue = (key: string, updated = 't1', extra: Partial<Issue> = {}): Issue => ({
  key,
  summary: `Issue ${key}`,
  status: 'To Do',
  priority: 'Medium',
  assignee: null,
  reporter: null,
  type: 'Task',
  project: 'A',
  created: 't0',
  updated,
  due: null,
  labels: [],
  description: '',
  ...extra,
})

function fakeClient(server: Record<string, Issue>) {
  const calls: string[] = []
  const client = {
    issue: async (key: string) => server[key],
    updateFields: async (key: string, fields: Record<string, unknown>) => {
      calls.push(`update ${key} ${JSON.stringify(fields)}`)
    },
    transitions: async () => [
      { id: '11', name: 'Start', to: 'In Progress' },
      { id: '21', name: 'Finish', to: 'Done' },
    ],
    transition: async (key: string, id: string) => {
      calls.push(`transition ${key} ${id}`)
    },
    assignableUsers: async () => [{ id: 'ana', displayName: 'Ana García' }],
    userField: (user: { id: string }) => ({ name: user.id }),
  }
  return { client: client as unknown as JiraClient, calls }
}

describe('Changes', () => {
  it('stages edits and drops ones that match the loaded value', () => {
    const changes = new Changes()
    changes.remember([issue('A-1')])
    changes.stage('A-1', 'status', 'Done')
    changes.stage('A-1', 'key', 'nope')
    expect(changes.edits('A-1')).toEqual({ status: 'Done' })
    changes.stage('A-1', 'status', 'To Do')
    expect(changes.count).toBe(0)
  })

  it('pushes fields, assignees and status transitions', async () => {
    const changes = new Changes()
    changes.remember([issue('A-1')])
    changes.stage('A-1', 'status', 'in progress')
    changes.stage('A-1', 'assignee', 'Ana García')
    changes.stage('A-1', 'priority', 'High')
    const { client, calls } = fakeClient({ 'A-1': issue('A-1') })
    const result = await changes.push(client)
    expect(result.pushed).toEqual(['A-1'])
    expect(calls).toEqual([
      'update A-1 {"priority":{"name":"High"},"assignee":{"name":"ana"}}',
      'transition A-1 11',
    ])
    expect(changes.count).toBe(0)
  })

  it('keeps the server version when the issue changed in Jira meanwhile', async () => {
    const changes = new Changes()
    changes.remember([issue('A-1', 't1')])
    changes.stage('A-1', 'summary', 'Mine')
    const { client, calls } = fakeClient({ 'A-1': issue('A-1', 't2') })
    const result = await changes.push(client)
    expect(result.conflicts).toEqual(['A-1'])
    expect(calls).toEqual([])
    expect(changes.count).toBe(0)
  })

  it('reports statuses the issue cannot move to and keeps the edit', async () => {
    const changes = new Changes()
    changes.remember([issue('A-1')])
    changes.stage('A-1', 'status', 'Archived')
    const { client } = fakeClient({ 'A-1': issue('A-1') })
    const result = await changes.push(client)
    expect(result.failed[0].error).toContain('can go to: In Progress, Done')
    expect(changes.count).toBe(1)
  })
})
