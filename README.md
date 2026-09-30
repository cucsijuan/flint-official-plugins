# Flint official plugins

Plugins for [Flint](https://github.com/cucsijuan/flint), one folder each. Install them from Flint: Settings → Plugins → Browse community plugins.

| Plugin | What it does |
| --- | --- |
| [Jira](jira) | Jira issues in your notes: tables from JQL queries, your issues in the sidebar, creating issues, comments and worklogs, with edits pushed only when you ask. |
| [Counter](counter) | Turns ` ```counter ` code blocks into a button that counts clicks in the note itself. |
| [Word count](word-count) | Word and character counts for the current note, and a command that inserts today's date. |

## Releasing

Each plugin is released on its own: push a tag `<folder>-<version>`, like `jira-0.2.0`, matching `version` in the plugin's `manifest.json`. The release workflow builds the plugin when it has a `package.json`, checks and tests it, and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release. Flint's [registry](https://github.com/cucsijuan/flint-plugins) finds each plugin's releases through its tag prefix.

## License

AGPL-3.0-or-later, like Flint.
