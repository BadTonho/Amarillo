local function postCommandResult(commandId, okValue, payload)
	if not state.sessionId then
		return
	end
	if okValue ~= true and payload and payload.error and payload.blocked ~= true and payload.declined ~= true then
		reportPluginError(payload.error, "PLUGIN-COMMAND", {
			commandId = commandId
		}, "error")
	end
	local body = {
		sessionId = state.sessionId,
		commandId = commandId,
		ok = okValue
	}
	addVersionPayload(body)
	for key, value in pairs(payload or {}) do
		body[key] = value
	end
	local ok, response = request("POST", "/studio/complete", body)
	if not ok then
		appendLog("Failed to confirm command with daemon: " .. tostring(response))
	end
	return ok, response
end

local function executeLuau(code)
	local loader = loadstring or load
	if not loader then
		return false, "loadstring is unavailable in this Studio."
	end

	local compiled, compileError = loader(code)
	if not compiled then
		return false, compileError
	end

	local ok, result = pcall(compiled)
	if not ok then
		return false, result
	end

	return true, result
end

executeRunCode = function(command)
	local ok, result = executeLuau(command.payload.code or "")
	postCommandResult(command.id, ok, {
		result = result,
		error = ok and nil or tostring(result),
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "LUAU_EXECUTION_FAILED"
	})
	appendLog(ok and "Luau executed through the daemon." or ("Luau failed: " .. tostring(result)))
end

local function getSelectionSummary()
	local selection = {}
	for _, instance in ipairs(Selection:Get()) do
		table.insert(selection, {
			name = instance.Name,
			className = instance.ClassName,
			fullName = instance:GetFullName()
		})
	end
	return selection
end

local function resolveInstanceByPath(pathString)
	if type(pathString) ~= "string" or pathString == "" then
		return nil
	end

	local segments = string.split(pathString, ".")
	if #segments == 0 then
		return nil
	end

	local startIndex = 1
	local current = game

	if string.lower(segments[1]) == "game" then
		startIndex = 2
	end

	for i = startIndex, #segments do
		local segment = segments[i]
		if i == startIndex then
			local ok, service = pcall(function()
				return game:GetService(segment)
			end)
			if ok and service then
				current = service
			else
				current = game:FindFirstChild(segment)
			end
		else
			current = current and current:FindFirstChild(segment)
		end
		if not current then
			return nil
		end
	end

	return current
end

local COMMON_PROPERTIES = {
	"Name", "ClassName", "Parent", "Archivable",
	-- BasePart
	"Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow",
	"Color", "Material", "Size", "Transparency", "Massless",
	"Shape", "BottomSurface", "TopSurface", "CFrame", "Position", "Orientation",
	"AssemblyLinearVelocity", "AssemblyAngularVelocity",
	-- MeshPart
	"MeshId", "TextureID", "RenderFidelity",
	-- Scripts
	"Source", "Enabled", "RunContext",
	-- GuiObject
	"AbsolutePosition", "AbsoluteSize", "AbsoluteRotation",
	"AnchorPoint", "BackgroundColor3", "BackgroundTransparency",
	"BorderColor3", "BorderSizePixel", "ClipsDescendants",
	"LayoutOrder", "Rotation", "SizeConstraint",
	"Visible", "ZIndex", "AutomaticSize",
	-- TextLabel/Button/Box
	"Text", "TextSize", "TextColor3", "TextTransparency",
	"TextWrapped", "TextXAlignment", "TextYAlignment",
	"Font", "FontFace", "RichText", "MaxVisibleGraphemes",
	-- ImageLabel/Button
	"Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter",
	-- ScreenGui
	"ResetOnSpawn", "IgnoreGuiInset", "DisplayOrder", "ZIndexBehavior",
	-- ScrollingFrame
	"CanvasSize", "CanvasPosition", "ScrollBarThickness",
	"ScrollingDirection", "ScrollingEnabled",
	-- UIStroke/UICorner/UIGradient/UIListLayout/UIPadding etc.
	"CornerRadius", "Thickness", "ApplyStrokeMode",
	"FillDirection", "HorizontalAlignment", "VerticalAlignment",
	"Padding", "PaddingLeft", "PaddingRight", "PaddingTop", "PaddingBottom",
	"SortOrder", "Wraps",
	-- Light
	"Brightness", "Range", "Shadows", "Angle", "Face",
	-- Sound
	"SoundId", "Volume", "PlaybackSpeed", "Looped", "Playing", "TimePosition", "TimeLength",
	-- ParticleEmitter / Beam
	"Rate", "Speed", "Lifetime", "Texture",
	-- Humanoid
	"Health", "MaxHealth", "WalkSpeed", "JumpPower", "JumpHeight",
	"HipHeight", "AutoRotate",
	-- Camera
	"CameraType", "FieldOfView", "CameraSubject",
	-- Folder / Model
	"PrimaryPart", "WorldPivot",
	-- Value objects
	"Value",
}

local function collectAllProperties(instance)
	local properties = {}

	for _, propName in ipairs(COMMON_PROPERTIES) do
		local ok, value = pcall(function()
			return instance[propName]
		end)
		if ok and value ~= nil then
			local serialized = serializeValue(value)
			if serialized ~= nil then
				properties[propName] = serialized
			elseif type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
				properties[propName] = value
			else
				properties[propName] = tostring(value)
			end
		end
	end

	-- Always include Parent path
	if instance.Parent then
		properties["_parentFullName"] = instance.Parent:GetFullName()
	end
	properties["_fullName"] = instance:GetFullName()

	-- Attributes
	local attributes, hasAttributes = syncableAttributes(instance:GetAttributes())
	if hasAttributes then
		properties["Attributes"] = attributes
	end

	-- Tags
	local tagsOk, tags = pcall(function()
		return instance:GetTags()
	end)
	if tagsOk and #tags > 0 then
		properties["_tags"] = tags
	end

	return properties
end

local function getDepthRelative(instance, root)
	local depth = 0
	local current = instance.Parent
	while current and current ~= root do
		depth = depth + 1
		current = current.Parent
	end
	return depth
end

local function handleCommand(command)
	if command.type == "apply_project_tree" then
		local isInitialPcSync = state.awaitingInitialSync and command.payload and command.payload.reason == "initial_pc_truth"
		local ok, message, appliedSnapshot, correctedDuringApply = applyProjectSnapshot(command.payload.project, command)
		if ok and isInitialPcSync then
			state.awaitingInitialSync = false
			local watcherOk, watcherErr = pcall(startWatcher)
			if not watcherOk then
				appendLog("Failed to start watcher after initial PC sync: " .. tostring(watcherErr))
				reportPluginError(tostring(watcherErr), "WATCHER-START")
			end
			updateStatus("connected")
			appendLog("Initial PC sync completed.")
		end
		postCommandResult(command.id, ok, {
			result = message,
			snapshot = appliedSnapshot,
			corrected = correctedDuringApply == true,
			error = ok and nil or message
		})
		appendLog(ok and "Local snapshot applied in Studio." or ("Apply failed: " .. tostring(message)))
		if not ok and isInitialPcSync then
			appendLog("Initial PC sync failed: " .. tostring(message))
			if resetSessionState then
				resetSessionState("initial sync failed")
			else
				state.awaitingInitialSync = false
				state.connected = false
				updateStatus("initial sync failed")
			end
		end
		return
	end

	if command.type == "apply_file_patch" then
		if command.payload and not isMountSyncEnabled(command.payload.path) then
			postCommandResult(command.id, true, {
				result = "Patch skipped because this sync target is disabled.",
				snapshot = snapshotCurrentProject(),
				skipped = true
			})
			return
		end
		local duplicateMessage = command.payload and duplicateMountRootGuardMessage("apply_file_patch", command.payload.path)
		if duplicateMessage then
			postCommandResult(command.id, false, {
				error = duplicateMessage,
				blocked = true,
				reasonCode = "DUPLICATE_MOUNT_ROOT"
			})
			appendLog(duplicateMessage)
			return
		end
		state.isApplyingRemote = true
		state.suppressPushUntil = now() + REMOTE_PUSH_SUPPRESSION_SECONDS
		local appliedSnapshot = nil
		
		local ok, err = pcall(function()
			local container = resolveMountContainer(command.payload.path)
			if container then
				local desiredSource = command.payload.source or ""
				local changed, updateOk, updateErr = updateScriptSourceIfChanged(container, desiredSource, nil, true)
				if not updateOk then
					error("Failed to update script source: " .. tostring(updateErr))
				end
				refreshOpenDocumentCache()
				if changed then
					ChangeHistoryService:SetWaypoint("Amarillo Patch: " .. container.Name)
				end
				appliedSnapshot = snapshotCurrentProject()
			else
				error("Instance not found for path: " .. table.concat(command.payload.path, "."))
			end
		end)
		
		state.isApplyingRemote = false
		postCommandResult(command.id, ok, {
			result = ok and "Patch aplicado" or tostring(err),
			snapshot = appliedSnapshot,
			error = ok and nil or tostring(err)
		})
		return
	end

	if command.type == "run_code" then
		if state.confirmPrivilegedActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another privileged action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("run_code rejected: another privileged action is already awaiting confirmation.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeRunCode(command)
		return
	end

	if command.type == "get_tree" then
		postCommandResult(command.id, true, {
			snapshot = snapshotCurrentProject()
		})
		appendLog("Current tree sent to the daemon.")
		return
	end

	if command.type == "get_selection" then
		postCommandResult(command.id, true, {
			selection = getSelectionSummary()
		})
		appendLog("Selection sent to the daemon.")
		return
	end

	if command.type == "playtest" then
		local ok, result = pcall(function()
			if command.payload.mode == "stop" then
				RunService:Stop()
				return "Playtest stopped"
			end
			RunService:Run()
			return "Playtest started"
		end)
		postCommandResult(command.id, ok, {
			result = result,
			error = ok and nil or tostring(result)
		})
		appendLog(ok and tostring(result) or ("Playtest failed: " .. tostring(result)))
		return
	end

	if command.type == "get_properties" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_properties falhou: caminho invalido.")
			return
		end
		local props = collectAllProperties(instance)
		postCommandResult(command.id, true, {
			path = command.payload.path,
			className = instance.ClassName,
			properties = props
		})
		appendLog("Properties sent to: " .. command.payload.path)
		return
	end

	if command.type == "get_descendants" then
		local root = resolveInstanceByPath(command.payload.path)
		if not root then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_descendants falhou: caminho invalido.")
			return
		end
		local maxDepth = command.payload.maxDepth or 10
		local classFilter = command.payload.classFilter
		local results = {}
		local MAX_RESULTS = 500

		local function walkDescendants(parent, currentDepth)
			if currentDepth > maxDepth or #results >= MAX_RESULTS then
				return
			end
			for _, child in ipairs(parent:GetChildren()) do
				if #results >= MAX_RESULTS then
					return
				end
				local matches = true
				if classFilter and classFilter ~= "" then
					matches = child:IsA(classFilter)
				end
				if matches then
					table.insert(results, {
						name = child.Name,
						className = child.ClassName,
						fullName = child:GetFullName(),
						depth = currentDepth,
						childCount = #child:GetChildren()
					})
				end
				walkDescendants(child, currentDepth + 1)
			end
		end

		walkDescendants(root, 1)
		postCommandResult(command.id, true, {
			path = command.payload.path,
			totalFound = #results,
			truncated = #results >= MAX_RESULTS,
			descendants = results
		})
		appendLog("Descendants enviados: " .. #results .. " de " .. command.payload.path)
		return
	end

	if command.type == "search_instances" then
		local query = string.lower(command.payload.query or "")
		local searchBy = command.payload.searchBy or "both"
		local scopeRoot = nil
		if command.payload.scope and command.payload.scope ~= "" then
			scopeRoot = resolveInstanceByPath(command.payload.scope)
		end
		if not scopeRoot then
			scopeRoot = game
		end

		local results = {}
		local MAX_RESULTS = 100

		local descendants = {}
		local ok = pcall(function()
			descendants = scopeRoot:GetDescendants()
		end)
		if not ok then
			descendants = scopeRoot:GetChildren()
		end

		for _, instance in ipairs(descendants) do
			if #results >= MAX_RESULTS then
				break
			end
			local nameMatch = searchBy ~= "className" and string.find(string.lower(instance.Name), query, 1, true)
			local classMatch = searchBy ~= "name" and string.find(string.lower(instance.ClassName), query, 1, true)
			if nameMatch or classMatch then
				table.insert(results, {
					name = instance.Name,
					className = instance.ClassName,
					fullName = instance:GetFullName(),
					parent = instance.Parent and instance.Parent:GetFullName() or "nil"
				})
			end
		end

		postCommandResult(command.id, true, {
			query = command.payload.query,
			totalFound = #results,
			truncated = #results >= MAX_RESULTS,
			results = results
		})
		appendLog("Busca concluida: " .. #results .. " resultados para '" .. command.payload.query .. "'")
		return
	end

	if command.type == "get_services" then
		local services = {}
		for _, child in ipairs(game:GetChildren()) do
			local childCountOk, childCount = pcall(function()
				return #child:GetChildren()
			end)
			table.insert(services, {
				name = child.Name,
				className = child.ClassName,
				childCount = childCountOk and childCount or 0
			})
		end
		table.sort(services, function(a, b)
			return a.name < b.name
		end)
		postCommandResult(command.id, true, {
			services = services,
			totalServices = #services
		})
		appendLog("Lista de services enviada: " .. #services .. " services.")
		return
	end

	if command.type == "get_instance_info" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_instance_info falhou: caminho invalido.")
			return
		end

		local children = {}
		for _, child in ipairs(instance:GetChildren()) do
			table.insert(children, {
				name = child.Name,
				className = child.ClassName,
				childCount = #child:GetChildren()
			})
		end
		table.sort(children, function(a, b)
			return a.name < b.name
		end)

		local props = collectAllProperties(instance)

		postCommandResult(command.id, true, {
			path = command.payload.path,
			name = instance.Name,
			className = instance.ClassName,
			fullName = instance:GetFullName(),
			parent = instance.Parent and instance.Parent:GetFullName() or "nil",
			children = children,
			childCount = #children,
			properties = props
		})
		appendLog("Info de instancia enviada: " .. command.payload.path)
		return
	end

	if command.type == "get_output_log" then
		local count = command.payload.count or 50
		local entries = {}
		local ok, logHistory = pcall(function()
			return LogService:GetLogHistory()
		end)
		if ok and logHistory then
			local startIndex = math.max(1, #logHistory - count + 1)
			for i = startIndex, #logHistory do
				local entry = logHistory[i]
				table.insert(entries, {
					message = entry.message,
					messageType = tostring(entry.messageType),
					timestamp = entry.timestamp
				})
			end
		end
		postCommandResult(command.id, true, {
			entries = entries,
			totalEntries = #entries
		})
		appendLog("Output log enviado: " .. #entries .. " entradas.")
		return
	end

	if command.type == "modify_property" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path),
				blocked = false,
				declined = false,
				confirmed = false,
				reasonCode = "INSTANCE_NOT_FOUND"
			})
			appendLog("modify_property falhou: caminho invalido.")
			return
		end

		if state.confirmPrivilegedActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another privileged action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("modify_property rejeitado: ja existe uma acao privilegiada aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end

		executeModifyProperty(command)
		return
	end

	if command.type == "create_instance" then
		if state.confirmPrivilegedActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another privileged action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("create_instance rejeitado: ja existe uma acao privilegiada aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeCreateInstance(command)
		return
	end

	if command.type == "delete_instance" then
		if state.confirmPrivilegedActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another privileged action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("delete_instance rejeitado: ja existe uma acao privilegiada aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeDeleteInstance(command)
		return
	end

	if command.type == "insert_model" then
		if state.confirmPrivilegedActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another privileged action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("insert_model rejeitado: ja existe uma acao privilegiada aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeInsertModel(command)
		return
	end

	if command.type == "set_privileged_action_confirmation" then
		local enabled = command.payload and command.payload.enabled == true
		if setPrivilegedActionConfirmation then
			setPrivilegedActionConfirmation(enabled, "VS Code")
		else
			state.confirmPrivilegedActions = enabled
			saveSettings()
		end
		postCommandResult(command.id, true, {
			result = enabled and "Privileged action confirmation enabled." or "Privileged action confirmation disabled.",
			enabled = enabled
		})
		appendLog("Privileged action confirmation set from VS Code: " .. (enabled and "enabled" or "disabled") .. ".")
		return
	end

	postCommandResult(command.id, false, {
		error = "Comando desconhecido: " .. tostring(command.type)
	})
end

local function handleCommandSafely(command)
	local isInitialPcSync = command
		and command.type == "apply_project_tree"
		and command.payload
		and command.payload.reason == "initial_pc_truth"
		and state.awaitingInitialSync
	local ok, err = xpcall(function()
		handleCommand(command)
	end, function(errorValue)
		return tostring(errorValue)
	end)
	if ok then
		return
	end

	state.isApplyingRemote = false
	local commandId = command and command.id or nil
	local commandType = command and command.type or "unknown"
	appendLog("Command failed: " .. tostring(commandType) .. " -> " .. tostring(err))
	reportPluginError(err, "PLUGIN-COMMAND", {
		commandId = commandId,
		commandType = commandType
	}, "error")
	if commandId then
		postCommandResult(commandId, false, {
			error = tostring(err)
		})
	end
	if isInitialPcSync then
		appendLog("Initial PC sync failed: " .. tostring(err))
		if resetSessionState then
			resetSessionState("initial sync failed")
		else
			state.awaitingInitialSync = false
			state.connected = false
			updateStatus("initial sync failed")
		end
	end
end
