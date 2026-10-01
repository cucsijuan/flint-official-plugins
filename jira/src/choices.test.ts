import { describe, expect, it } from 'vitest'
import { fieldChoices } from './choices'
import type { Issue, JiraClient } from './client'

const issue = { key: 'FL-1', status: 'To Do', project: 'FL' } as Issue

const client = {
  transitions: async () => [
    { id: '1', name: 'Start', to: 'In Progress' },
    { id: '2', name: 'Finish', to: 'Done' },
  ],
  priorities: async () => ['High', 'Low'],
  assignableUsers: async (_project: string, query: string) =>
    [
      { id: 'ada', displayName: 'Ada' },
      { id: 'bob', displayName: 'Bob' },
    ].filter((user) => user.displayName.toLowerCase().includes(query)),
} as unknown as JiraClient

describe('fieldChoices', () => {
  it('offers the current status and the ones a transition reaches', async () => {
    expect(await fieldChoices(client, issue, 'status', '')).toEqual([
      'To Do',
      'In Progress',
      'Done',
    ])
  })

  it('offers priorities, and assignable people plus nobody', async () => {
    expect(await fieldChoices(client, issue, 'priority', '')).toEqual(['High', 'Low'])
    expect(await fieldChoices(client, issue, 'assignee', 'a')).toEqual(['', 'Ada'])
  })

  it('keeps free text for other fields', async () => {
    expect(await fieldChoices(client, issue, 'summary', '')).toBeNull()
  })
})
