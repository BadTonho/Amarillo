# Example Roblox Workspace

This workspace exists so you can manually validate the Amarillo bridge without treating the repository root as a Roblox project.

Use this folder to:

- run the local daemon while developing the extension;
- generate an example `mcp.json` during local tests;
- connect the Roblox Studio plugin and validate `push/pull`, `run_code`, and MCP introspection.

Example files:

- `src/ServerScriptService/Hello.server.luau`
- `src/ReplicatedStorage/Shared/Hello.luau`
- `src/StarterPlayer/StarterPlayerScripts/ClientHello.client.luau`

The end-user flow is still to open the real Roblox workspace in VS Code and use `Amarillo: Configure MCP for Workspace`.
