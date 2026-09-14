# OpenCode Auto Permissions

[![release](https://img.shields.io/github/v/release/hueyexe/opencode-auto-permissions.svg)](https://github.com/hueyexe/opencode-auto-permissions/releases)
[![npm](https://img.shields.io/npm/v/opencode-auto-permissions.svg)](https://www.npmjs.com/package/opencode-auto-permissions)
[![tests](https://img.shields.io/badge/tests-regression%20suite-brightgreen.svg)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-stable%20%2B%20V2-blue.svg)](./docs/COMPATIBILITY_SPIKE.md)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Automatic, context-aware permission review for OpenCode. Let routine work run normally, send riskier actions to a reviewer model, and keep coding agents moving while you are away.

This fork adds **server-side permission review for OpenCode V2 desktop, web, and terminal clients**, tested on OpenCode `2.0.1`. No terminal needs to stay open. The existing V1 and older V2-beta adapters remain available.

On released V2, approvals apply to the current evaluation only; the plugin never writes saved permission rules.

## Install

Install this fork's server-review branch globally with OpenCode's built-in plugin installer. If the upstream npm package is already configured, remove that entry first:

```bash
opencode plugin remove opencode-auto-permissions
opencode plugin add 'git+ssh://git@github.com/dParikesit/opencode-auto-permissions.git#feature/v2-server-permission-review'
```

The upstream npm release `opencode-auto-permissions@0.2.13` does not include this server-side V2 adaptation. Use the Git target above to get it. The repository includes built artifacts, so installation does not require a local build.

That is the complete plugin installation. You do not need to clone this repository, install Bun, run `npm install`, choose a reviewer model, or edit plugin entries manually.

OpenCode downloads the package and registers the Git target in `~/.config/opencode/opencode.json`. For a remote server, install it on the server's machine under the server user's configuration.

OpenCode watches configuration changes. If an existing server has not reloaded the plugin, restart it with `opencode service restart`. Auto Permissions automatically uses the requesting session's model and variant. Released V2 runs the review on the server; its TUI adapter stays inactive, including in shadow mode.

## Configure Permissions

The recommended setup is not to set every permission to `ask`. Allow routine work in OpenCode, then use `ask` for operations where context matters. Only `ask` requests reach Auto Permissions. For example, add risk-based rules to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "rm *", "effect": "ask" },
    { "action": "shell", "resource": "sudo *", "effect": "ask" },
    { "action": "shell", "resource": "git push *", "effect": "ask" },
    { "action": "shell", "resource": "git reset --hard*", "effect": "ask" },
    { "action": "shell", "resource": "git clean -f*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
  ]
}
```

OpenCode uses the last matching permission rule, so keep the broad `allow` rule first and the narrower `ask` rules after it. These are example patterns, not a complete shell policy. Installation does not add permission rules automatically.

Confirm the configured target with `opencode plugin list`, then exercise a harmless action covered by an `ask` rule. An active plugin status alone does not prove a review occurred. No `cli.json` entry is required on released V2.

## Update

Update the package plugin to the latest published version:

```bash
opencode plugin update 'git+ssh://git@github.com/dParikesit/opencode-auto-permissions.git#feature/v2-server-permission-review'
```

If your configuration entry pins a version (for example `opencode-auto-permissions@0.2.10`), remove the pin or repoint it first; the updater treats a satisfied version pin as current. Older stable builds use `opencode plugin -g --force opencode-auto-permissions@latest` instead.

Restart the server if the updated package has not reloaded. Older V2 beta installations that configure both server and TUI options should keep those options synchronized.

## Uninstall

Remove the configured Git target with `opencode plugin remove 'git+ssh://git@github.com/dParikesit/opencode-auto-permissions.git#feature/v2-server-permission-review'`, or remove its entry from `plugins` in `~/.config/opencode/opencode.json`.

Remove only this package's entries; leave other plugins and configuration unchanged.

## How It Works

For each supported permission request, Auto Permissions combines deterministic safety rules with an isolated, one-step reviewer model:

- OpenCode handles `allow` and `deny` rules before the plugin; Auto Permissions reviews requests configured as `ask`.
- Explicit user prohibitions and clearly catastrophic root/home deletion are rejected without model review.
- Contextual risks such as `sudo`, scoped deletion, force push, deployment, credential access, and external-directory access are judged against the user's request and target scope.
- External-directory boundaries are not treated as sensitive by default: ordinary project, tool, cache, log, state, temporary, and worktree paths are approved unless the target or operation presents a concrete hazard.
- Broad boundary globs such as `/tmp/*` are not treated as the requested scope when the tool input identifies a precise target; the reviewer evaluates the actual operation and latest user request.
- The reviewer is tuned for unattended agents: it defaults to approval when an action reasonably serves the task and uses `ask` only as a last resort.
- Reviewer failures and timeouts fail closed: the request is rejected automatically and the main agent receives guidance to continue with a narrower or lower-risk step.
- Released V2 uses the tool-free `generate.text` API: no reviewer session is created and no repository instructions, MCP tools, or full transcript are attached. Older adapters use hidden, tool-free reviewer sessions.
- Only a small, recent window of relevant user context is sent for review.
- Plugin-authored denial continuations are excluded from that context so an earlier verdict cannot become a self-reinforcing human instruction.

The reviewer never receives authority to execute the requested action. On released V2, the `permission.hook("evaluate")` callback returns `allow` or `deny` before OpenCode publishes a permission prompt. Denial feedback is returned through the hook's `message`, without injecting a user message or changing session routing. In `shadow` mode the original `ask` decision and feedback are preserved.

On older adapters, reviewer sessions are standalone and deleted after each decision or failure. Startup never deletes another process's reviewer sessions.

Auto Permissions never asks the user to resolve a permission prompt. When the reviewer cannot safely approve, it denies and tells the coding agent why, what safer alternative to try, and to continue autonomously where possible.

Denial and failure continuations preserve the main session's selected agent, model, and variant. A permission decision does not reset the primary agent's reasoning effort.

### Session Approvals

**Released V2 always approves once.** Its evaluation hook supplies no tool-proposed save patterns, so even an `allow_session` verdict is downgraded to a one-time allow. Concurrent identical reviews in the same requesting session can share a model call; the key includes the current user context, model, and directory. Later requests are reviewed again.

Older adapters support guarded `allow_session` replies using OpenCode's tool-provided `always` patterns. The following pattern-reuse behavior applies to those adapters only.

Code-side guardrails downgrade `allow_session` to a one-time approval when patterns are missing or broad, or when the action involves edits, external-directory boundaries, `sudo`, deletion, push, publish, deploy, credentials, destructive Git, or other non-repeatable effects. Eligible examples include narrow reads/searches and commands such as a specific `git fetch` or test invocation. Set `sessionApprovals: false` to force all model approvals to remain one-time.

When an action is rejected, Auto Permissions returns the reason to the main agent and asks it to continue with a safer alternative when possible. For example, it can target a generated subdirectory instead of a broad recursive delete, use `--force-with-lease` instead of an unrestricted force push, or inspect a deployment plan before applying it. A denial should redirect useful work rather than end the session.

## Choosing Rules

Use OpenCode's three permission outcomes deliberately:

| Rule | Use it for | Plugin behavior |
| --- | --- | --- |
| `allow` | Routine, expected work that should never wait | OpenCode runs it immediately; the reviewer is not called. |
| `ask` | Risk depends on user intent, target, or scope | Auto Permissions reviews context and replies once. |
| `deny` | Actions that must never run in your environment | OpenCode blocks it immediately; the reviewer cannot override it. |

For unattended multi-agent work, prefer `allow` for ordinary reads, edits, tests, builds, and source-control inspection. Prefer `ask` over `deny` for commands that can be legitimate in the right context. Reserve `deny` for firm organizational or personal boundaries.

Avoid an all-`ask` configuration unless you are evaluating the plugin in `shadow` mode. It adds model latency to every tool call and makes reviewer outages affect routine work.

## Configuration

Plugin options accept these settings:

| Option | Default | Description |
| --- | --- | --- |
| `model` | Requesting session model | Optional dedicated reviewer model in `provider/model` form. |
| `variant` | Selected model's default | Optional reviewer-only model variant. Use `"low"` when supported for faster decisions. |
| `sessionApprovals` | `true` | Pattern reuse on older adapters. Released V2 always uses one-time approvals. |
| `timeoutMs` | `30000` | Review timeout from 100 to 30,000 milliseconds. The default accommodates a cold reviewer startup. |
| `userMessageCount` | `8` | Recent user messages included in review context, from 1 to 20. |
| `shadow` | `false` | Evaluate and record decisions without replying to permission requests. |
| `runtime` | `"auto"` | Diagnostics override: `"auto"`, `"stable"`, or `"v2"`. Leave this on `"auto"` in normal use. |
| `debug` | `false` | Write the latest 100 privacy-minimized outcomes to a JSONL file. Use `true` for the default path or provide a file path. |

Set `shadow: true` to record decisions while retaining manual approval. On released V2, configure options only on the server plugin entry.

No options are required. To select a dedicated reviewer, replace the Git target string in `plugins` with an object:

```json
{
  "package": "git+ssh://git@github.com/dParikesit/opencode-auto-permissions.git#feature/v2-server-permission-review",
  "options": { "model": "openai/gpt-4.1", "timeoutMs": 30000 }
}
```

Choose a model available through your server's configured providers. V2's stateless generation API uses the server's base/global provider configuration; a reviewer model defined only in project configuration may be unavailable. A fast model that follows JSON instructions reliably works best. Older V2 betas still require synchronized server/TUI options.

With `debug: true`, diagnostics are written to `$XDG_STATE_HOME/opencode/auto-permissions/decisions.jsonl` (normally `~/.local/state/opencode/auto-permissions/decisions.jsonl`). The native V2 adapter records action type, timing, verdict, reason code, and failure category. It omits raw provider errors and model-authored reasons because those may echo private data. Commands, paths, tool inputs, and conversation text are not logged by this adapter.

Access to this bounded diagnostics file is deterministically allowed by the plugin so troubleshooting cannot be blocked by speculative sensitivity concerns. This exception applies only to Auto Permissions' own `decisions.jsonl` path.

Native V2 review makes a stateless request with the requesting session's model and variant (or configured override). For subagents, only the root session's human messages supply authorization context; delegated user-role briefings are excluded. Parent traversal is bounded and cycles fail closed.

Native V2 bounds the whole review, including context retrieval, by `timeoutMs`. Unloading the plugin aborts in-flight calls and prevents late approvals. Neither cancellation nor a malformed model response grants permission.

The plugin does not force a universal reasoning level because variant names differ by provider. Omitting `variant` uses the selected model's variant. Avoid high or maximum reasoning for permission review unless your policy requires unusually complex analysis.

## Compatibility

Runtime ownership and verification:

| Runtime | Review owner | Verification |
| --- | --- | --- |
| OpenCode V2 `2.0.1` | Server evaluation hook; desktop, web, and TUI clients | Packed-plugin headless integration checks against a local mock model |
| Earlier V2 betas | TUI adapter | Existing unit coverage and prior TUI acceptance baseline below |
| OpenCode V1 | Legacy server adapter | Existing unit coverage and prior TUI acceptance baseline below |

Prior upstream TUI acceptance baselines:

- OpenCode stable `1.18.12`
- OpenCode V2 `0.0.0-beta-202608110357`

The native V2 path uses the documented evaluation hook and does not subscribe to permission events. The older adapters still accept both historical event shapes. See [Testing](docs/TESTING.md) for reproducible headless checks and the [compatibility notes](docs/COMPATIBILITY_SPIKE.md) for historical protocol details.

## Development

This section is only for contributors. Users installing through `opencode plugin` do not need Bun or a repository checkout.

Development requires [Bun](https://bun.sh/) and Node.js 22 or later:

```bash
bun install
bun run verify
```

`verify` runs strict TypeScript checks, the test suite, a production build, and package export smoke tests. Isolated runtime launchers are also available:

```bash
bun run test:stable
bun run test:v2
bun run test:v2-server
```

The launchers leave normal OpenCode configuration and session data untouched. See [Testing](docs/TESTING.md) for setup and acceptance scenarios.

Contributions go through pull requests with prefixed branches. See [Contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE)
