# Support

Turnlane is a side project maintained by one person. Questions, bug reports, and ideas are welcome and are read, but there is no promise of a reply or a fix on any schedule. The pointers below make it more likely that you get an answer, often from another user.

## Where to go

| I want to... | Go to |
|---|---|
| Ask how something works, share a setup, or discuss an idea | [GitHub Discussions](https://github.com/turnlane/turnlane/discussions) |
| Propose support for another coding agent | [Adapter request](https://github.com/turnlane/turnlane/issues/new?template=adapter_request.yml) issue, or the *Adapters* category in Discussions |
| Report something that is broken | [Bug report](https://github.com/turnlane/turnlane/issues/new?template=bug_report.yml) issue |
| Suggest a feature | [Feature request](https://github.com/turnlane/turnlane/issues/new?template=feature_request.yml) issue, after a look at Discussions |
| Report a security problem | [SECURITY.md](SECURITY.md) (private reporting; not a public issue) |

Discussions is the default. Use the categories: **Q&A** for questions, **Ideas** for things that are not yet concrete enough for an issue, **Adapters** for other agents' log formats, **Show and tell** for how you use Turnlane.

## Before you ask

1. Run `turnlane doctor`. It checks the daemon, the database, the agents it found, hooks, MCP registration, the calendar helper, and the update check, and tells you what is off.
2. Run `turnlane doctor --redact` and paste the output into your issue or discussion. It contains versions, state codes, and counts; home paths, user names, host names, repository names, titles, and calendar names are removed. You can check the output before pasting.
3. For daemon problems: `turnlane daemon status` and `turnlane daemon logs -n 100`. The logs never contain conversation text, but they can contain repository paths, so look through them before sharing.
4. Never paste conversation text from Claude Code or Codex sessions, session files, or credentials. If the problem is in how a file is parsed, describe the structure (field names, line shapes) rather than attaching the file; the maintainer cannot accept real session files.

## What is not supported

- Operating systems other than macOS, and Intel Macs.
- Agents other than those listed in the README, until someone contributes an adapter.
- Setups where Turnlane's binaries or data are moved out of their default locations by hand.
