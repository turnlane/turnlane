# Security policy

Turnlane runs entirely on your Mac: a local daemon on `127.0.0.1`, a CLI, and a desktop shell. It reads the local files of Claude Code and Codex (metadata only), edits those tools' hook and MCP configuration when you ask it to, and talks to macOS Calendar. There is no server component. Please keep that model in mind when deciding whether something is a security issue; a report is most useful when it shows how data could leave the machine, how conversation text could end up stored, how another local user or process could read Turnlane's data, or how Turnlane could be made to modify files it should not touch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab and choose **Report a vulnerability**. That creates a private advisory that only you and the maintainer can see.

Please do not open a public issue, discussion, or pull request for a suspected vulnerability.

Include what you can of:

- the version (`turnlane --version`, or the commit if built from source) and macOS version;
- the output of `turnlane doctor --redact` if relevant (it removes paths, user names, repository names, and titles);
- steps to reproduce, and what an attacker gains;
- whether it involves the hooks or MCP configuration of another tool, the calendar helper, or the update check.

Do not include conversation text from your agent sessions, credentials, or anything that identifies a client. If a proof of concept needs a session file, describe its structure instead of attaching it.

## What to expect

This is a side project maintained by one person in their spare time. Reports are read, but there is no guaranteed response time, no bug bounty, and no commitment to fix any particular issue. Confirmed vulnerabilities that affect the current release are fixed in the next release when possible, with credit in the release notes if you want it.

## Supported versions

Only the latest release and the `main` branch receive fixes. Pre-release builds are not supported.

## Scope notes

- The daemon's HTTP API is bound to the loopback interface and protected by a per-install token that is only exposed to local clients. Reports that require an attacker to already run code as your user are still welcome, but note that macOS does not isolate processes running under the same user from each other.
- The update check performs a plain GET of a static file on GitHub Releases. Tampering with that file would require control of the GitHub repository or the TLS connection.
- Extensions bundled with the official build are outside this repository; issues in them can still be reported here and will be routed.
