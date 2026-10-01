import type { Issue, JiraClient } from './client'

const priorities = new WeakMap<JiraClient, Promise<string[]>>()

const unique = (values: string[]) => [...new Set(values)]

/** The values an issue's field accepts, for the table's dropdowns; `null` for free text. */
export async function fieldChoices(
  client: JiraClient,
  issue: Issue,
  field: string,
  query: string,
): Promise<string[] | null> {
  switch (field) {
    case 'status': {
      const transitions = await client.transitions(issue.key)
      return unique([issue.status, ...transitions.map(({ to }) => to)])
    }
    case 'priority': {
      let known = priorities.get(client)
      if (!known) {
        known = client.priorities()
        known.catch(() => priorities.delete(client))
        priorities.set(client, known)
      }
      return known
    }
    case 'assignee': {
      const users = await client.assignableUsers(issue.project, query)
      return ['', ...unique(users.map(({ displayName }) => displayName))]
    }
    default:
      return null
  }
}
