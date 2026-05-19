assert(plugin, "Amarillo must run as a Roblox Studio plugin")

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local InsertService = game:GetService("InsertService")
local MarketplaceService = game:GetService("MarketplaceService")
local okScriptEditor, ScriptEditorService = pcall(function() return game:GetService("ScriptEditorService") end)

local SETTINGS_KEY = "AmarilloSettings"
local PLUGIN_VERSION = "1.1.13"
local AMARILLO_PROTOCOL_VERSION = 2
local DEFAULT_HOST = "127.0.0.1"
local LEGACY_DEFAULT_PORT = 8123
local DEFAULT_PORT = 8323
local POLL_MIN_INTERVAL = 0.25
local POLL_MAX_INTERVAL = 1.0
local POLL_IDLE_THRESHOLD_1 = 5.0
local POLL_IDLE_THRESHOLD_2 = 30.0
local OFFER_ACTIVE_POLL_INTERVAL = 0.5
local OFFER_IDLE_POLL_INTERVAL = 1.5
local OFFER_RETRY_POLL_INTERVAL = 1.0
local SNAPSHOT_INTERVAL = 0.5
local REMOTE_PUSH_SUPPRESSION_SECONDS = 1.0
local SCRIPT_PATCH_DEBOUNCE_SECONDS = 0.35
local INITIAL_STUDIO_SYNC_RETRY_SECONDS = 2.0
local INITIAL_STUDIO_SYNC_LOG_SECONDS = 10.0
local SAFE_SET_ERROR_DEDUPE_SECONDS = 30.0
local SAFE_SET_FAILURE_REPORT_LIMIT = 10

local state = {
	host = DEFAULT_HOST,
	port = DEFAULT_PORT,
	portCustomized = false,
	studioInstanceId = HttpService:GenerateGUID(false),
	sessionId = nil,
	sessionToken = nil,
	project = nil,
	connected = false,
	awaitingInitialSync = false,
	awaitingInitialStudioSync = false,
	lastInitialStudioSyncAttemptAt = 0,
	lastInitialStudioSyncErrorAt = 0,
	lastInitialStudioSyncErrorMessage = nil,
	selectedProjectId = nil,
	selectedProjectName = nil,
	projectSelectionReason = nil,
	projectSelectionMessage = nil,
	workspaceRoot = nil,
	workspaceName = nil,
	connectionOffer = nil,
	seenOfferIds = {},
	pendingConnectionContext = nil,
	settingsProjectId = nil,
	availableProjects = {},
	currentView = "home",
	lastSnapshotBodyJson = nil,
	suppressPushUntil = 0,
	lastPollAt = 0,
	lastSnapshotAt = 0,
	lastActivityAt = 0,
	isApplyingRemote = false,
	logs = {},
	treeCache = nil,
	pendingScriptPatches = {},
	openDocumentCache = {},
	pendingDestructiveCommand = nil,
	pendingDestructiveSinceAt = nil,
	confirmPrivilegedActions = true,
	syncState = "ready",
	syncMessage = nil,
	versionState = "unknown",
	versionMessage = nil,
	lastSyncStatusMessage = nil,
	ui = {}
}

local disconnectWatcher
local startWatcher
local resetSessionState
local widget
local function isExperienceRunning()
	local ok, running = pcall(function()
		return RunService:IsRunning()
	end)
	return ok and running == true
end

local function hidePluginWidget()
	if widget then
		widget.Enabled = false
	end
end

local function showPluginWidget()
	if not widget then
		return false
	end
	if isExperienceRunning() then
		hidePluginWidget()
		return false
	end
	widget.Enabled = true
	return true
end

local function togglePluginWidget()
	if not widget then
		return
	end
	if widget.Enabled then
		hidePluginWidget()
	else
		showPluginWidget()
	end
end

local executeModifyProperty
local executeCreateInstance
local executeDeleteInstance
local executeInsertModel
local executeRunCode
local executeDestructiveCommand
local showDestructiveConfirmation
local hideDestructiveConfirmation
local acceptDestructiveAction
local declineDestructiveAction
local setPrivilegedActionConfirmation
local updatePrivilegedActionConfirmationUi
