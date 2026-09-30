import type { HttpRequest } from 'flint-plugin-api'
import { describe, expect, it } from 'vitest'
import { JiraClient, jiraTime } from './client'

type Reply = { status?: number; body: unknown }

function fakeHttp(replies: Record<string, Reply | ((request: HttpRequest) => Reply)>) {
  const requests: HttpRequest[] = []
  const http = async (request: HttpRequest) => {
    requests.push(request)
    const path = request.url.replace(/^https:\/\/jira\.test\/rest\/api\/\d/, '')
    const match = Object.entries(replies).find(([prefix]) =>
      `${request.method} ${path}`.startsWith(prefix),
    )
    if (!match) throw new Error(`Unexpected request: ${request.method} ${path}`)
    const reply = typeof match[1] === 'function' ? match[1](request) : match[1]
    const body = JSON.stringify(reply.body)
    return { status: reply.status ?? 200, headers: {}, body, json: <T>() => JSON.parse(body) as T }
  }
  return { http, requests }
}

const rawIssue = (key: string, fields: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: 'To Do' },
    updated: '2026-09-30T10:00:00.000+0000',
    ...fields,
  },
})

const server = { url: 'https://jira.test/', deployment: 'server' as const, email: '', token: 'pat' }
const cloud = {
  url: 'https://jira.test',
  deployment: 'cloud' as const,
  email: 'me@test',
  token: 'api',
}

describe('JiraClient', () => {
  it('uses a bearer token and v2 paging on Server', async () => {
    let page = 0
    const { http, requests } = fakeHttp({
      'GET /search?': () => {
        page++
        return page === 1
          ? { body: { issues: [rawIssue('A-1'), rawIssue('A-2')], total: 3 } }
          : { body: { issues: [rawIssue('A-3')], total: 3 } }
      },
    })
    const issues = await new JiraClient(server, http).search('project = A')
    expect(issues.map((issue) => issue.key)).toEqual(['A-1', 'A-2', 'A-3'])
    expect(requests[0].headers?.Authorization).toBe('Bearer pat')
    expect(requests[1].url).toContain('startAt=2')
  })

  it('uses basic auth, v3 token paging and document text on Cloud', async () => {
    const { http, requests } = fakeHttp({
      'GET /search/jql?': (request) =>
        request.url.includes('nextPageToken=next')
          ? { body: { issues: [rawIssue('B-2')], isLast: true } }
          : {
              body: {
                issues: [
                  rawIssue('B-1', {
                    description: {
                      type: 'doc',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
                    },
                  }),
                ],
                nextPageToken: 'next',
                isLast: false,
              },
            },
      'POST /issue/B-1/comment': { status: 201, body: {} },
    })
    const client = new JiraClient(cloud, http)
    const issues = await client.search('project = B')
    expect(issues.map((issue) => issue.key)).toEqual(['B-1', 'B-2'])
    expect(issues[0].description).toBe('Hello')
    expect(requests[0].headers?.Authorization).toBe(`Basic ${btoa('me@test:api')}`)
    await client.addComment('B-1', 'Nice')
    expect(JSON.parse(requests.at(-1)?.body ?? '{}').body.type).toBe('doc')
  })

  it("reports Jira's error messages", async () => {
    const { http } = fakeHttp({
      'GET /issue/X-1': { status: 404, body: { errorMessages: ['Issue does not exist'] } },
    })
    await expect(new JiraClient(server, http).issue('X-1')).rejects.toThrow(
      '404: Issue does not exist',
    )
  })

  it('formats times the way Jira expects', () => {
    expect(jiraTime(new Date('2026-09-30T10:00:00Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/,
    )
  })
})
