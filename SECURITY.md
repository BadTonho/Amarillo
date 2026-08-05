# Amarillo Security Policy

Amarillo is architected with deep, layers-in-depth defensive security protections to guarantee that bidirectional synchronization between VS Code and Roblox Studio remains isolated, authenticated, and resilient against unauthorized local or network access.

## Trust Boundaries & Network Isolation

### 1. Loopback-Exclusive Binding (127.0.0.1)
By default, the Amarillo HTTP daemon and MCP server bind strictly to the local loopback interface (`127.0.0.1` / `localhost`).
- **External Network Defense:** Operating systems automatically drop and reject any inbound packets coming from LAN Wi-Fi interfaces or the open internet attempting to reach port `8323`.
- **Local Origin Strictness:** Administrative routes and MCP tools implement rigorous origin checking and CORS preflight validation, rejecting requests coming from unauthorized web browser origins or external scripts.

### 2. External Host Protection (Bridge Tokens)
If an advanced user manually configures the daemon to listen on a non-loopback host (e.g., `0.0.0.0` or a local LAN address):
- The daemon explicitly blocks initialization if a **Bridge Token** is not provided.
- All non-public endpoints enforce mandatory bearer token authentication (`Authorization: Bearer <token>` or custom bridge token headers) before fulfilling commands or MCP interactions.
- Sensitive credentials, bridge tokens, and machine-specific file paths are isolated inside `.amarillo/mcp-local.json`, which is permanently blacklisted in `.gitignore` to prevent git leaks.

### 3. Session & Token Cryptography
During the initial Studio connection handshake, the daemon issues a securely generated session token to the active Roblox Studio client. Every polling request, diff verification, and command execution validate this session token independently from global bridge credentials.

---

## Roblox Studio Sandbox & Safeguards

### 1. Privileged Action Gates
Operations capable of executing arbitrary code or performing severe modifications inside Roblox Studio are gated behind safety checklists and interactive user confirmations:
- **`run_code` and Dynamic Scripting:** Arbitrary Luau script execution requested via MCP triggers a verification modal inside Roblox Studio. The execution remains blocked until the developer explicitly clicks **Accept** in the Studio DockWidget UI.
- **Destructive Operation Blocking:** Any attempts to modify or delete instances via MCP or synchronization paths outside authorized active Sync Mounts are rejected automatically.
- **Rate-Limiting:** Windowed rate-limiting mitigates Denial-of-Service (DoS) and spam execution from automated AI tool loops or external scripts.

### 2. Path Traversal & Filesystem Hardening
- **Path Sanitization:** Node names in Roblox Studio that incorporate directory traversal syntaxes (such as `..\outside` or subpath escapes) are intercepted during serialization and mapped to safe, escaped filesystem names (`__outside`), storing their original name metadata solely within `init.meta.json`.
- **Sandbox Integrity:** Sync operations are strictly confined to authorized project mounts; the daemon will reject source patching that attempts to access parent directories or arbitrary Windows folders.

---

## Dependency Vulnerability Management

Amarillo proactively mitigates transitive package security vulnerabilities through NPM overrides:
- **`ip-address` (>= 10.3.1 / 10.4.0):** Resolves leading-zero octal decoding anomalies and IPv4-mapped/NAT64 misclassifications that could otherwise bypass trust boundaries or SSRF safeguards.
- **`fast-uri` (>= 3.1.5 / 4.1.2):** Resolves URI authority parser desyncs when handling backslash authority introducers.
- **`hono` (>= 4.12.34 / 4.13.0):** Prevents Regular Expression Denial of Service (ReDoS) during CORS preflight `Access-Control-Request-Headers` processing.

---

## Reporting a Vulnerability

If you discover a potential security vulnerability, bypass, or improper data exposure within the Amarillo bridge, please **do not** open a public GitHub issue immediately.

1. **Private Notice:** Send a direct report via GitHub Private Security Advisories on the repository or contact the lead maintainer directly.
2. **Response Timeline:** Acknowledgment of reports typically occurs within 48 hours, followed by an accelerated patching workflow and advisory publication upon release of a patched version.
