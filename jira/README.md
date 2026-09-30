# Jira for Flint

A [Flint](https://github.com/cucsijuan/flint) plugin that brings Jira issues into your notes. It works with Jira Server/Data Center and Jira Cloud, and needs Flint 0.12 or later.

- **Issue tables:** write a JQL query in a `jira` code block and get a table you can filter, sort, group and summarize, with the views of Flint's Bases (table, cards, list, map).
- **Your issues:** the Jira sidebar tab lists your open issues, or someone else's.
- **Edit, then push:** change an issue's summary, status, priority, assignee or due date right in the table. Edits stay local, marked in the Unpushed column, until you press **Push changes**. If an issue changed in Jira since it was loaded, Jira's version wins and your edits to that issue are dropped.
- **Create issues, comment and log time** from the issue's details (click its title) or with the **New** button.

````markdown
```jira
project = ABC AND status != Done ORDER BY priority DESC
```
````

## Setting up

In Flint, open Settings → Plugin options → Jira:

1. **Jira URL:** your site, like `https://jira.example.com` or `https://example.atlassian.net`.
2. **Type:** Server / Data Center or Cloud.
3. **Token:** a [personal access token](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html) on Server/Data Center, or an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) plus your account's email on Cloud. The token is kept in your system's keychain, never in the vault.
4. Press **Test connection**.

Requests go through Flint's backend, so your Jira doesn't need to allow the app's origin, and certificates from your system's store are trusted (for companies with their own certificate authority).

## Developing

```sh
npm install
npm run check && npm test
FLINT_PLUGIN_DIR=/path/to/vault/.flint/plugins/jira npm run dev
```

Pushing a tag that matches `version` in `manifest.json` publishes a release with `main.js`, `manifest.json` and `styles.css`.

## License

AGPL-3.0-or-later, like Flint.
