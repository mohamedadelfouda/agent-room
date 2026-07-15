# Connectors and MCP

Agent Room currently defines GitHub, Gmail, and Supabase connectors in `server/connectors/registry.js`.

## Approval contract

1. The user enables a connector for one session.
2. Read-only actions may execute after opt-in.
3. A state-changing MCP tool call creates a `pending` connector action and returns that proposal to the agent.
4. The UI displays the action name and exact input.
5. Reject marks it rejected. Approve persists `executing_unknown` and the decision log **before** the external request.
6. Success becomes `completed`. Failure after approval becomes `failed_after_approval` and is never retried automatically.

This ordering prevents duplicate emails, issues, or rows after a crash. Create a new proposal when a failed action is safe to retry.

Connectors remain unavailable while an attached project is untrusted.

## Configuration

GitHub uses the signed-in native `gh` executable. In the installed desktop app, Gmail and Supabase credentials can be entered from the connector's **Configure** control. Electron encrypts that file with the operating system's secure-storage backend. Linux's insecure `basic_text` fallback is deliberately rejected; use a Secret Service/KWallet backend or the environment variables below.

Source/server deployments can use host-only environment variables:

| Connector | Variables |
| --- | --- |
| Gmail | `AGENT_ROOM_GMAIL_ACCESS_TOKEN` |
| Supabase | `AGENT_ROOM_SUPABASE_URL`, `AGENT_ROOM_SUPABASE_KEY` |

These values stay in the Agent Room host process. Agent, GitHub, and publication subprocess policies do not forward them. The stdio MCP child receives only a random per-run loopback grant; the host resolves that grant to one session and one capability class, then performs storage and connector work.

Gmail implements `list_messages`, `get_message`, and `send_message`. Supabase implements bounded `select_rows` and one-row `insert_row`. GitHub implements `list_repositories` and `create_issue`; pull requests remain part of execution acceptance.

## Add a connector action

Add the action to one connector's `actions` map with `description`, `stateChanging`, and `run(input)`. Mark every external write as state-changing. Validate identifiers, sizes, destinations, and URL schemes before the network call. Redact provider errors before storing them.

The stdio proxy is `server/mcp-server.js`. The host exposes only connectors enabled for the session bound to its short-lived grant. Tool annotations identify read-only and state-changing actions. Approval uses an atomic `pending` → `executing_unknown` claim, so two simultaneous approvals cannot run the same external side effect twice. The UI keeps uncertain actions visible and never retries them automatically.
