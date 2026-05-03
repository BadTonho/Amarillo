"use strict";

const TOOL_DEFINITIONS = [
  {
    name: "health",
    description: "Returns daemon status, workspace details, and active sessions.",
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
    description: "Executes Luau in the connected Studio session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "code"],
      properties: {
        sessionId: {
          type: "string"
        },
        code: {
          type: "string"
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
          description: "Maximum search depth between 1 and 10."
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
          description: "Maximum number of entries to return. Default is 50 and maximum is 200."
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
  findNodeByPath,
  listTools
};
