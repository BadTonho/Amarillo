"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { findNodeByPath, listTools, validateToolArguments } = require("./mcp-tools");
const { readLocalProjectStateAsync } = require("./project");
const { startStdioMcpServer, textContent } = require("./mcp-stdio");
function healthPayload(app) {
    const sessions = Array.from(app.sessions.values()).map((session) => app.sessionSummary(session));
    const payload = {
        workspaceRoot: app.workspaceRoot,
        projects: app.listProjects(),
        connectionOffer: app.connectionOfferSummary(),
        sessions
    };
    if (sessions.length === 0) {
        payload._hint = "No active Studio session found. Call connect_session with a projectId from the projects list above to create one, then use the returned sessionId for subsequent tool calls.";
    }
    return payload;
}
function parseToolPayload(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const firstText = content.find((item) => item && item.type === "text" && typeof item.text === "string")?.text || "";
    if (!firstText) {
        return null;
    }
    try {
        return JSON.parse(firstText);
    }
    catch (_error) {
        return null;
    }
}
function summarizeValue(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return {
            type: "array",
            length: value.length
        };
    }
    if (typeof value === "object") {
        return {
            type: "object",
            keys: Object.keys(value).slice(0, 10)
        };
    }
    const text = String(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
function summarizeToolArguments(name, args = {}) {
    switch (name) {
        case "set_active_project":
            return { projectId: args.projectId || null };
        case "connect_session":
            return {
                projectId: args.projectId || null,
                placeId: Number(args.placeId) || 0
            };
        case "run_code":
            return {
                sessionId: args.sessionId || null,
                codeLength: typeof args.code === "string" ? args.code.length : 0
            };
        case "inspect_instance":
        case "get_properties":
        case "get_instance_info":
        case "delete_instance":
            return {
                sessionId: args.sessionId || null,
                path: args.path || null
            };
        case "get_tree":
        case "get_selection":
        case "push_changes":
        case "pull_changes":
        case "start_playtest":
        case "stop_playtest":
        case "get_services":
            return {
                sessionId: args.sessionId || null
            };
        case "get_descendants":
            return {
                sessionId: args.sessionId || null,
                path: args.path || null,
                maxDepth: args.maxDepth || null,
                classFilter: args.classFilter || null
            };
        case "search_instances":
            return {
                sessionId: args.sessionId || null,
                query: summarizeValue(args.query),
                searchBy: args.searchBy || "both",
                scope: args.scope || null
            };
        case "get_output_log":
            return {
                sessionId: args.sessionId || null,
                count: args.count || null
            };
        case "modify_property":
            return {
                sessionId: args.sessionId || null,
                path: args.path || null,
                property: args.property || null,
                value: summarizeValue(args.value)
            };
        case "create_instance":
            return {
                sessionId: args.sessionId || null,
                parentPath: args.parentPath || null,
                className: args.className || null,
                name: args.name || args.className || null,
                propertyCount: Object.keys(args.properties || {}).length
            };
        case "insert_model":
            return {
                sessionId: args.sessionId || null,
                query: summarizeValue(args.query)
            };
        default:
            return {};
    }
}
function summarizeToolResult(name, payload) {
    if (!payload || typeof payload !== "object") {
        return payload === null ? null : { type: typeof payload };
    }
    const common = {
        ok: payload.ok !== false,
        blocked: payload.blocked === true,
        declined: payload.declined === true,
        confirmed: payload.confirmed === true,
        reasonCode: payload.reasonCode || null
    };
    switch (name) {
        case "health":
            return {
                ...common,
                sessionCount: Array.isArray(payload.sessions) ? payload.sessions.length : 0,
                projectCount: Array.isArray(payload.projects) ? payload.projects.length : 0
            };
        case "list_projects":
            return {
                ...common,
                projectCount: Array.isArray(payload) ? payload.length : 0
            };
        case "connect_session":
            return {
                ...common,
                sessionId: payload.sessionId || payload.session?.id || null,
                projectId: payload.project?.id || null
            };
        case "get_tree":
            return {
                ...common,
                mountCount: Array.isArray(payload.mounts) ? payload.mounts.length : 0
            };
        case "get_selection":
            return {
                ...common,
                selectionCount: Array.isArray(payload) ? payload.length : 0
            };
        case "get_descendants":
        case "search_instances":
        case "get_services":
        case "get_output_log":
            return {
                ...common,
                totalEntries: payload.totalEntries || payload.totalResults || payload.count || null,
                entryCount: Array.isArray(payload.entries) ? payload.entries.length : (Array.isArray(payload.results) ? payload.results.length : null)
            };
        case "push_changes":
            return {
                ...common,
                snapshotHash: payload.snapshotHash || null
            };
        case "run_code":
            return {
                ...common,
                outputLength: typeof payload.output === "string" ? payload.output.length : null
            };
        case "modify_property":
        case "create_instance":
        case "delete_instance":
        case "insert_model":
            return {
                ...common,
                result: summarizeValue(payload.result || payload.fullName || payload.deletedPath || payload.insertedName || null)
            };
        default:
            return common;
    }
}
const TOOL_HANDLERS = {
    health: async (app) => textContent(healthPayload(app)),
    list_projects: async (app) => textContent(app.listProjects()),
    set_active_project: async (app, args) => textContent(await app.setActiveProject(args.projectId)),
    connect_session: async (app, args) => {
        const { session, project } = app.openSession(Number(args.placeId) || 0, args.projectId || null, { connectionState: "ready", truthSource: "pc" });
        return textContent({
            ok: true,
            sessionId: session.id,
            session: app.sessionSummary(session),
            project: { id: project.id, name: project.name },
            _hint: "Session created. Use the sessionId above in subsequent tool calls (get_tree, get_services, etc.)."
        });
    },
    get_tree: async (app, args) => textContent(await app.requestStudioTree(args.sessionId)),
    get_selection: async (app, args) => textContent(await app.requestStudioSelection(args.sessionId)),
    inspect_instance: async (app, args) => {
        const snapshot = await app.requestStudioTree(args.sessionId);
        const node = findNodeByPath(snapshot, args.path);
        return textContent(node || { error: "Node not found." });
    },
    run_code: async (app, args) => textContent(await app.runStudioCode(args.sessionId, args.code)),
    push_changes: async (app, args) => {
        const snapshot = await app.requestStudioTree(args.sessionId);
        return textContent({
            ok: true,
            snapshot,
            snapshotHash: app.sessions.get(args.sessionId)?.lastStudioHash || null
        });
    },
    pull_changes: async (app, args) => {
        const session = app.sessions.get(args.sessionId);
        const project = session ? app.getProjectById(session.projectId) : null;
        const result = await app.enqueueCommand(args.sessionId, "apply_project_tree", {
            project: project ? await readLocalProjectStateAsync(project, app.projectReadOptions(session)) : null,
            reason: "mcp_pull"
        }, true);
        return textContent({ ok: true, result });
    },
    start_playtest: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "playtest", { mode: "start" }, true)),
    stop_playtest: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "playtest", { mode: "stop" }, true)),
    get_properties: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "get_properties", { path: args.path }, true)),
    get_descendants: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "get_descendants", {
        path: args.path,
        maxDepth: Math.min(Math.max(Number(args.maxDepth) || 10, 1), 10),
        classFilter: args.classFilter || null
    }, true)),
    search_instances: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "search_instances", {
        query: args.query,
        searchBy: args.searchBy || "both",
        scope: args.scope || null
    }, true)),
    get_services: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "get_services", {}, true)),
    get_instance_info: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "get_instance_info", { path: args.path }, true)),
    get_output_log: async (app, args) => textContent(await app.enqueueCommand(args.sessionId, "get_output_log", {
        count: Math.min(Math.max(Number(args.count) || 50, 1), 200)
    }, true)),
    modify_property: async (app, args) => textContent(await app.enqueueDestructiveCommand(args.sessionId, "modify_property", {
        path: args.path,
        property: args.property,
        value: args.value
    })),
    create_instance: async (app, args) => textContent(await app.enqueueDestructiveCommand(args.sessionId, "create_instance", {
        parentPath: args.parentPath,
        className: args.className,
        name: args.name || args.className,
        properties: args.properties || {}
    })),
    delete_instance: async (app, args) => textContent(await app.enqueueDestructiveCommand(args.sessionId, "delete_instance", { path: args.path })),
    insert_model: async (app, args) => textContent(await app.enqueueDestructiveCommand(args.sessionId, "insert_model", { query: args.query }))
};
async function executeTool(app, name, args) {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
        throw new Error(`Unsupported MCP tool: ${name}`);
    }
    validateToolArguments(name, args || {});
    return handler(app, args || {});
}
async function handleTool(app, name, args = {}, options = {}) {
    const source = options.source || "native_stdio";
    const startedAt = Date.now();
    if (source && typeof app.recordMcpContact === "function") {
        app.recordMcpContact(source, { toolName: name });
    }
    try {
        const result = await executeTool(app, name, args || {});
        const payload = parseToolPayload(result);
        if (typeof app.recordMcpAudit === "function") {
            app.recordMcpAudit({
                tool: name,
                source,
                sessionId: args.sessionId || payload?.sessionId || payload?.session?.id || null,
                args: summarizeToolArguments(name, args || {}),
                result: summarizeToolResult(name, payload),
                ok: payload?.ok !== false,
                blocked: payload?.blocked === true,
                declined: payload?.declined === true,
                confirmed: payload?.confirmed === true,
                reasonCode: payload?.reasonCode || null,
                error: payload?.error || null,
                durationMs: Date.now() - startedAt
            });
        }
        return result;
    }
    catch (error) {
        if (source && typeof app.recordMcpFailure === "function") {
            app.recordMcpFailure(source, error, { toolName: name });
        }
        if (typeof app.recordMcpAudit === "function") {
            app.recordMcpAudit({
                tool: name,
                source,
                sessionId: args.sessionId || null,
                args: summarizeToolArguments(name, args || {}),
                result: null,
                ok: false,
                blocked: false,
                declined: false,
                confirmed: false,
                reasonCode: null,
                error: error.message,
                durationMs: Date.now() - startedAt
            });
        }
        throw error;
    }
}
async function startMcpServer(app) {
    await startStdioMcpServer({
        serverInfo: {
            name: "amarillo-mcp",
            version: "0.1.0"
        },
        listTools,
        handleTool: (name, args) => handleTool(app, name, args)
    });
}
module.exports = {
    TOOL_HANDLERS,
    handleTool,
    healthPayload,
    startMcpServer
};
