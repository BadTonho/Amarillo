# Amarillo architecture

```text
AI client / MCP client
        |
        | stdio or authenticated HTTP fallback
        v
VS Code MCP bootstrap ----> local MCP proxy
                                   |
                                   v
                         Amarillo daemon (Node)
                         - project discovery
                         - session registry
                         - MCP tools and policy gates
                         - local activity/error/audit logs
                                   |
                                   | localhost HTTP + session token
                                   v
                         Roblox Studio plugin
                         - Studio tree and snapshots
                         - command execution
                         - privileged-action confirmation
                                   |
                                   v
                          Workspace project files
```

## Trust boundaries

- The daemon listens on loopback by default. When it is configured to listen outside loopback, connection routes require a bridge token and startup fails without one.
- The bridge token and installed extension path are local state stored in `.amarillo/mcp-local.json`; that file must never be committed.
- Studio receives its own random session token during the connection handshake. Studio routes validate that token independently from the bridge token.
- Privileged MCP tools (`run_code`, property changes, instance creation/deletion, and model insertion) pass through session-health, rate-limit, and optional Studio confirmation gates.

## Synchronization flow

1. The daemon discovers Argon project files and their mounts in the workspace.
2. The VS Code extension starts the daemon and writes only portable MCP bootstrap configuration into the workspace.
3. The Studio plugin establishes a session, reports its snapshot, and receives a session token.
4. MCP calls are translated into daemon operations or Studio commands.
5. Studio replies with results and verification snapshots; the daemon updates local project state when the selected source of truth requires it.

## Code ownership

- `src/daemon/app.ts` owns daemon lifecycle and session orchestration.
- `src/daemon/routes/` owns HTTP route adapters.
- `src/daemon/services/` owns focused lifecycle services such as workspace watching and snapshot writes.
- `src/daemon/contracts/` is the shared TypeScript boundary for daemon modules.
- `src/plugin-src/` owns the source of truth for the generated Roblox plugin bundle.
