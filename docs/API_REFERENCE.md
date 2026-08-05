# Amarillo Internal API & Module Reference

This document serves as a granular technical reference for contributors and maintainers, detailing the responsibilities, core functions, and operational flows of each internal sub-system within the Amarillo Bridge, Daemon runtime, VS Code extension, and Roblox Studio plugin bundle.

---

## 1. Daemon Core & Orchestration (`src/daemon/`)

The local Node.js daemon acts as the centralized authority mediating traffic between VS Code, AI/MCP clients, and Roblox Studio.

### `app.ts` (`AmarilloDaemonApp`)
The primary lifecycle coordinator and server bootstrapper.
- **`start()`**: Initializes local configuration, starts workspace watchers, binds the HTTP server to configured network ports (defaulting strictly to loopback `127.0.0.1:8323`), and begins listening for connections.
- **`authorizeHttpRequest(req, url)`**: Validates requests against loopback origin requirements, bridge tokens (when exposed outside loopback), and session token signatures.
- **`handleHttp(req, res)`**: High-performance HTTP routing engine dispatching incoming packets to corresponding module adapters.
- **`refreshWorkspace()`**: Triggers re-parsing of project configuration files and active sync targets.

### `project.ts` & `project-discovery.ts`
Handles parsing and hierarchical merging of Rojo/Argon project configurations.
- **`loadProject(path)`**: Parses JSON/Toml project specifications, stripping reserved RBX attributes and sanitizing invalid structural rules.
- **`resolvePlaceProject(placeId)`**: Matches Studio clients to specific place configurations; applies inheritance rules where derived projects override abstract base projects via the `extends` directive without contaminating unrelated project nodes.
- **`ensureWorkspaceProjectFile()`**: Automatically scaffolds a clean `default.project.json` containing initial sync roots when encountering empty workspaces.

### `mcp-stdio.ts` & `mcp-shield.ts`
- **`stdio -> HTTP proxy`**: Translates input commands from standard input streams into structured JSON-RPC or REST HTTP calls sent directly to the local daemon, allowing AI IDE assistants (Codex, Claude, Cursor) to interact without spinning up redundant background bridges.
- **`MCP Shield`**: Enforces rate limits, origin checks, and parameter validation across all incoming MCP method executions.

---

## 2. Specialized Lifecycle Services (`src/daemon/services/`)

### `doctor-service.ts` (`DoctorService`)
Responsible for continuous system diagnostics and preflight checking.
- **`diagnose()`**: Audits network accessibility, checks for missing sync mounts, monitors memory consumption, and verifies Studio connection latency.
- **`aggregateDiagnosticErrors()`**: Collects runtime safe-set exceptions and Studio mutation failures to feed directly into developer diagnostics logs and MCP `health` tool outputs.

### `session-registry.ts` (`SessionRegistry`)
Manages cryptographic authentication states across multiple connected Roblox Studio windows.
- **`registerSession(identity, placeId)`**: Issues unique session authentication tokens and binds place identities to designated project catalogs.
- **`validateToken(sessionId, token)`**: Fast-path token matching used by incoming Studio requests to ensure session integrity.

### `studio-snapshot-writer.ts` (`StudioSnapshotWriter`)
Manages high-speed asynchronous serialization of Studio instance hierarchies to local filesystem trees.
- **`writeSnapshot(snapshot)`**: Converts instance nodes into folders, `.lua`, or `.luau` files based on class names and file kind attributes.
- **`sanitizePath(nodeName)`**: Converts unsafe filesystem characters and directory traversal syntaxes (e.g., `..\` or invalid OS characters) into escaped safe names (`__outside`), recording original Roblox identifiers in sidecar `init.meta.json` manifests.
- **`pruneModelDirectories()`**: Safely removes outdated local Model directory configurations during syncback operations while keeping opaque Studio assets intact.

### `sync-coordinator.ts` & `workspace-watcher.ts`
- **`SyncCoordinator`**: Orchestrates bidirectional synchronization between local workspace files and live Studio trees without causing infinite echoing loops; manages exclusive mounts and verification snapshots.
- **`WorkspaceWatcher`**: Lightweight local filesystem observer that monitors `.lua`, `.luau`, and project files; applies rate-limiting and debouncing before informing connected Studio sessions of file patches.

---

## 3. Core Libraries & Utilities (`src/daemon/lib/`)

- **`snapshot-hash.ts`**: Implements dual-hashing change detection. Calculates both a semantic property hash (normalizing default Roblox property attributes like `ZIndex` or `Archivable`) and a raw SHA-1 hash to ensure accurate diffing and eliminate redundant disk writes when values match defaults.
- **`error-tracker.ts`**: Intelligent deduplication filter that generates structured event signatures for recurring engine errors or network warnings, preventing runaway console output and preserving daemon stability.
- **`rate-limiter.ts`**: Windowed sliding execution limiter that blocks overwhelming API traffic from faulty automation loop patterns or aggressive clients.
- **`mcp-audit-log.ts`**: Maintains persistent transaction journals inside `.amarillo/activity/YYYY-MM-DD/`, recording MCP tool executions in both structured machine-readable format (`mcp.jsonl`) and human-readable reports (`mcp.md`).
- **`perf-tracker.ts`**: Microsecond benchmarking utility tracking serialization speeds and IPC transmission latency.

---

## 4. HTTP Route Adapters (`src/daemon/routes/`)

- **`connection.ts`**: Handles `/connection/offer`, `/connection/accept`, and `/connection/decline` routes to negotiate secure handshakes with incoming Studio plugins.
- **`studio.ts`**: Implements high-volume operational endpoints (`/studio/poll`, `/studio/snapshot`, `/studio/command_result`). Incorporates transparent Gzip/Brotli stream decompression to maximize payload speeds on large instance trees.
- **`mcp.ts`**: Serves REST and JSON-RPC implementations of all 20 standardized MCP tools, dispatching requests either directly to local disk introspection or queuing commands for connected Studio sessions.
- **`diagnostics.ts`**: Exposes `/diagnostics/doctor` and health check probes for external monitoring scripts and IDE UI indicators.

---

## 5. Roblox Studio Plugin Architecture (`src/plugin-src/`)

The Studio plugin code is modularized into sequentially numbered Luau source fragments in `src/plugin-src/`. During `npm run build:plugin`, the generator combines these modules into a standalone optimized file at `src/plugin/Amarillo.lua` using `manifest.json`.

### Module Responsibility Breakdown

| Module | Purpose & Core Functions |
| :--- | :--- |
| **`00_bootstrap.lua`** | Initializes global plugin scopes, declares protocol constants, verifies Studio execution security contexts, and registers top-level event handlers. |
| **`10_settings_status.lua`** | Manages persistent plugin Settings across Studio sessions (e.g., privileged action toggles, adaptive polling rates) and maintains real-time status UI badges. |
| **`20_http.lua`** | Provides robust HTTP wrappers around `HttpService`; injects cryptographic session tokens, manages adaptive backoff retries during disconnections, and encodes/decodes Gzip compressed JSON payloads. |
| **`30_values_properties.lua`** | Serializes Roblox data structures (`CFrame`, `Color3`, `Vector3`, `UDim2`, Attributes) into JSON-compatible abstractions; filters reserved RBX system attributes during serialization. |
| **`40_snapshot_sync.lua`** | Recursively traverses the active Place hierarchy to generate structured instance snapshots; manages exclusive mount containers and regenerates `AmarilloId` UUIDs on cloned instances. |
| **`50_commands.lua`** | Command dispatcher receiving instructions from the daemon; safely executes DOM tree mutations (`create_instance`, `delete_instance`, `modify_property`, `patch_source`) inside defensive exception wrappers. |
| **`60_connection_flow.lua`** | Controls the connection handshake state machine; polls the daemon for incoming commands using adaptive intervals when idle vs. active. |
| **`70_privileged_actions.lua`** | Enforces the safety gate for high-risk operations (such as arbitrary `run_code` scripts); summons an interactive confirmation modal on the plugin UI requiring explicit developer acceptance before code execution occurs in Studio. |
| **`80_ui.lua`** | Generates the reactive DockWidget interface and Settings menus inside Roblox Studio while preserving registers below strict engine limits; keeps widgets hidden automatically during Playtest sessions. |
| **`90_watchers_loops.lua`** | Sets up background loops and event listeners on `Workspace` and `ScriptEditorService` to track local modifications, refreshing open document caches immediately after external patches arrive. |
