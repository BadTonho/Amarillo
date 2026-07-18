"use strict";

import type {
  McpToolArguments,
  McpToolDefinition,
  McpToolInputSchema,
  McpToolPropertySchema
} from "./contracts/mcp";

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "health",
    description: "Returns daemon status, workspace details, and active sessions. IMPORTANT: If sessions[] is empty, it means no Roblox Studio session is connected. In that case: (1) call list_projects to see available projects, (2) call connect_session with a projectId to create a session, (3) then use the returned sessionId for subsequent tool calls.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "list_projects",
    description: "Lists the Argon projects discovered in the workspace.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "set_active_project",
    description: "Sets the default project for new sessions.",
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "connect_session",
    description: "Creates a new Studio session directly without requiring the offer/accept handshake. Use this when health shows an empty sessions[] array but the Roblox Studio plugin is running. Returns the new sessionId to use in subsequent tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Optional project ID to connect to. If omitted, the daemon selects the default or only project."
        },
        placeId: {
          type: "number",
          description: "Optional Roblox place ID for project matching.",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER
        }
      }
    }
  },
  {
    name: "get_tree",
    description: "Returns the current Studio tree for a connected session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "get_selection",
    description: "Returns the current Studio selection.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "inspect_instance",
    description: "Looks up a path in the Studio tree and returns the matching node.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string"
        }
      }
    }
  },
  {
    name: "run_code",
    description: "Executes Luau in the connected Studio session. Privileged operation; the plugin can require confirmation before running.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "code"],
      properties: {
        sessionId: {
          type: "string"
        },
        code: {
          type: "string",
          maxLength: 256 * 1024
        }
      }
    }
  },
  {
    name: "push_changes",
    description: "Captures the current Studio state and writes it to disk.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "pull_changes",
    description: "Reads the local project state and applies it in Studio.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "start_playtest",
    description: "Starts playtest through the plugin.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "stop_playtest",
    description: "Stops playtest through the plugin.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "get_properties",
    description: "Returns all readable properties of a Studio instance by full path.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Instance path, for example game.Workspace.MyPart."
        }
      }
    }
  },
  {
    name: "get_descendants",
    description: "Lists descendants of an instance with optional className filtering and a maximum depth of 10.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Root instance path, for example game.Workspace."
        },
        maxDepth: {
          type: "number",
          description: "Maximum search depth between 1 and 10.",
          minimum: 1,
          maximum: 10
        },
        classFilter: {
          type: "string",
          description: "Filter only instances of this className."
        }
      }
    }
  },
  {
    name: "search_instances",
    description: "Searches instances across the whole game by name or className.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "query"],
      properties: {
        sessionId: {
          type: "string"
        },
        query: {
          type: "string",
          description: "Text to search for using partial, case-insensitive matching."
        },
        searchBy: {
          type: "string",
          description: "Search by name, className, or both.",
          enum: ["name", "className", "both"]
        },
        scope: {
          type: "string",
          description: "Search scope, or empty for the entire game."
        }
      }
    }
  },
  {
    name: "get_services",
    description: "Lists available services in the game with direct child counts.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        }
      }
    }
  },
  {
    name: "get_instance_info",
    description: "Returns detailed information about an instance, including children and readable properties.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Instance path, for example game.Workspace.MyModel."
        }
      }
    }
  },
  {
    name: "get_output_log",
    description: "Returns the latest entries from the Studio Output log.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string"
        },
        count: {
          type: "number",
          description: "Maximum number of entries to return. Default is 50 and maximum is 200.",
          minimum: 1,
          maximum: 200
        }
      }
    }
  },
  {
    name: "modify_property",
    description: "Changes an instance property or attribute in Studio. Destructive operation.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path", "property", "value"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Instance path, for example game.Workspace.MyPart."
        },
        property: {
          type: "string",
          description: "Name of the property to change."
        },
        value: {
          description: "New property value, serialized when required."
        }
      }
    }
  },
  {
    name: "create_instance",
    description: "Creates a new child instance under a parent in Studio. Destructive operation.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "parentPath", "className"],
      properties: {
        sessionId: {
          type: "string"
        },
        parentPath: {
          type: "string",
          description: "Parent path where the instance should be created."
        },
        className: {
          type: "string",
          description: "ClassName of the new instance."
        },
        name: {
          type: "string",
          description: "Name of the new instance. Defaults to className."
        },
        properties: {
          type: "object",
          description: "Initial properties to set after creating the instance."
        }
      }
    }
  },
  {
    name: "delete_instance",
    description: "Deletes an instance by path. Destructive operation.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "path"],
      properties: {
        sessionId: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Path of the instance to delete."
        }
      }
    }
  },
  {
    name: "insert_model",
    description: "Inserts the first free Roblox marketplace model that matches a query into Workspace. Destructive operation.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "query"],
      properties: {
        sessionId: {
          type: "string"
        },
        query: {
          type: "string",
          description: "Query to search for the model"
        }
      }
    }
  }
];

function listTools() {
  return {
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
}

const TOOL_DEFINITION_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STRING_LENGTH = 8192;
const MAX_STRING_LENGTH_BY_KEY = {
  code: 256 * 1024,
  path: 2048,
  parentPath: 2048,
  query: 512,
  sessionId: 128,
  projectId: 512,
  property: 256,
  className: 128,
  classFilter: 128,
  name: 256,
  scope: 2048
};

function validateToolArguments(name: string, args: McpToolArguments = {}): McpToolArguments {
  const tool = TOOL_DEFINITION_BY_NAME.get(name);
  if (!tool) {
    throw new Error(`Unsupported MCP tool: ${name}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Arguments for MCP tool '${name}' must be an object.`);
  }
  let serializedBytes = 0;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(args), "utf8");
  } catch (_error) {
    throw new Error(`Arguments for MCP tool '${name}' must be JSON-serializable.`);
  }
  if (serializedBytes > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error(`Arguments for MCP tool '${name}' exceed ${MAX_TOOL_ARGUMENT_BYTES} bytes.`);
  }
  const schema: McpToolInputSchema = tool.inputSchema || { type: "object" };
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new Error(`Missing required argument '${key}' for MCP tool '${name}'.`);
    }
  }

  for (const [key, definition] of Object.entries(properties) as [string, McpToolPropertySchema][]) {
    const value = args[key];
    if (value === undefined || value === null || definition.type === undefined) {
      continue;
    }
    if ((definition.type === "number" || definition.type === "integer")
      && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Argument '${key}' for MCP tool '${name}' must be a number.`);
    }
    if (definition.type === "integer" && !Number.isInteger(value)) {
      throw new Error(`Argument '${key}' for MCP tool '${name}' must be an integer.`);
    }
    if (definition.type === "string" && typeof value !== "string") {
      throw new Error(`Argument '${key}' for MCP tool '${name}' must be a string.`);
    }
    if (definition.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`Argument '${key}' for MCP tool '${name}' must be an object.`);
    }
    if (definition.type === "string") {
      const maxLength = Number.isFinite(definition.maxLength)
        ? definition.maxLength
        : MAX_STRING_LENGTH_BY_KEY[key] || DEFAULT_MAX_STRING_LENGTH;
      if ((value as string).length < Number(definition.minLength || 0)) {
        throw new Error(`Argument '${key}' for MCP tool '${name}' is too short.`);
      }
      if ((value as string).length > maxLength) {
        throw new Error(`Argument '${key}' for MCP tool '${name}' exceeds ${maxLength} characters.`);
      }
      if (definition.pattern && !(new RegExp(definition.pattern)).test(value as string)) {
        throw new Error(`Argument '${key}' for MCP tool '${name}' has an invalid format.`);
      }
    }
    if (definition.type === "number" || definition.type === "integer") {
      if (definition.minimum !== undefined && (value as number) < definition.minimum) {
        throw new Error(`Argument '${key}' for MCP tool '${name}' is below the minimum.`);
      }
      if (definition.maximum !== undefined && (value as number) > definition.maximum) {
        throw new Error(`Argument '${key}' for MCP tool '${name}' exceeds the maximum.`);
      }
    }
    if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
      throw new Error(`Argument '${key}' for MCP tool '${name}' must be one of: ${definition.enum.join(", ")}.`);
    }
  }

  return args;
}

function luaLongString(value) {
  const text = String(value ?? "");
  let equals = "";
  while (text.includes(`]${equals}]`)) {
    equals += "=";
  }
  return `[${equals}[${text}]${equals}]`;
}

function buildInsertModelLua(query) {
  return `
local InsertService = game:GetService("InsertService")
local success, results = pcall(function()
    return InsertService:GetFreeModels(${luaLongString(query)}, 0)
end)

if success and results and type(results) == "table" and #results > 0 then
    local assetId = results[1].AssetId
    local loadSuccess, model = pcall(function()
        return InsertService:LoadAsset(assetId)
    end)

    if loadSuccess and model then
        local children = model:GetChildren()
        for _, child in ipairs(children) do
            child.Parent = workspace
        end
        if #children == 1 then
            print("Inserted: " .. children[1].Name .. " (Asset ID: " .. assetId .. ")")
        else
            print("Inserted Model with " .. #children .. " items (Asset ID: " .. assetId .. ")")
        end
        model:Destroy()
    else
        print("Failed to load asset: " .. tostring(model))
    end
else
    print("No models found or error searching for query: " .. tostring(results))
end
`;
}

function findNodeByPath(snapshot, searchPath) {
  const segments = String(searchPath)
    .replace(/^game\./i, "")
    .split(".")
    .filter(Boolean);

  if (segments.length === 0) {
    return snapshot;
  }

  let currentLevel = snapshot.mounts || [];
  let currentNode = null;

  for (const segment of segments) {
    if (!Array.isArray(currentLevel)) {
      return null;
    }

    const mountMatch = currentLevel.find((mount) => mount.segments && mount.segments[mount.segments.length - 1] === segment);
    if (mountMatch) {
      currentNode = mountMatch;
      currentLevel = mountMatch.children || [];
      continue;
    }

    const childMatch = currentLevel.find((node) => node.name === segment);
    if (!childMatch) {
      return null;
    }

    currentNode = childMatch;
    currentLevel = childMatch.children || [];
  }

  return currentNode;
}

module.exports = {
  TOOL_DEFINITIONS,
  buildInsertModelLua,
  findNodeByPath,
  listTools,
  validateToolArguments
};

