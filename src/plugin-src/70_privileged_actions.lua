-- ===== Privileged Action Confirmation System =====
local function formatValueForDisplay(value)
	if type(value) == "table" then
		local okEncode, encoded = pcall(function()
			return HttpService:JSONEncode(value)
		end)
		if okEncode then
			if #encoded > 80 then
				return string.sub(encoded, 1, 77) .. "..."
			end
			return encoded
		end
	end
	return tostring(value)
end

local function postOutsideSyncMountResult(command, actionName, pathSegments)
	local message = syncMountGuardMessage(actionName, pathSegments)
	postCommandResult(command.id, false, {
		error = message,
		blocked = true,
		declined = false,
		confirmed = false,
		reasonCode = "OUTSIDE_SYNC_MOUNT"
	})
	appendLog(message)
end

local function postDuplicateMountRootResult(command, actionName, pathSegments)
	local message = duplicateMountRootGuardMessage(actionName, pathSegments)
	postCommandResult(command.id, false, {
		error = message,
		blocked = true,
		declined = false,
		confirmed = false,
		reasonCode = "DUPLICATE_MOUNT_ROOT"
	})
	appendLog(message)
end

executeModifyProperty = function(command)
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

	local targetSegments = getInstancePathSegments(instance)
	if not isPathInsideActiveSyncMount(targetSegments) then
		postOutsideSyncMountResult(command, "modify_property", targetSegments)
		return
	end
	if duplicateMountRootIssueForPath(targetSegments) then
		postDuplicateMountRootResult(command, "modify_property", targetSegments)
		return
	end

	local propName = command.payload.property
	local rawValue = command.payload.value

	-- Verificacao: ler valor atual primeiro
	local currentValue = safeGetProperty(instance, propName)
	if currentValue == nil and propName ~= "Value" then
		-- Tenta verificar se eh atributo
		local attrValue = instance:GetAttribute(propName)
		if attrValue ~= nil then
			-- Eh um atributo, setar como atributo
			local ok, err = pcall(function()
				ChangeHistoryService:SetWaypoint("MCP modify attribute: " .. propName)
				local okAttribute, attributeErr = safeSetAttribute(instance, propName, rawValue, "MCP modify attribute")
				if not okAttribute then
					error(attributeErr)
				end
				ChangeHistoryService:SetWaypoint("MCP modify attribute done")
			end)
			postCommandResult(command.id, ok, {
				result = ok and "Attribute changed successfully" or nil,
				error = ok and nil or tostring(err),
				path = command.payload.path,
				property = propName,
				blocked = false,
				declined = false,
				confirmed = true,
				reasonCode = ok and nil or "MODIFY_FAILED"
			})
			appendLog(ok and ("Attribute " .. propName .. " changed at " .. command.payload.path) or ("modify_property failed: " .. tostring(err)))
			return
		end
	end

	local ok, err = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP modify property: " .. propName)
		local okProperty, propertyErr = setProperty(instance, propName, rawValue)
		if not okProperty then
			error(propertyErr)
		end
		ChangeHistoryService:SetWaypoint("MCP modify property done")
	end)
	postCommandResult(command.id, ok, {
		result = ok and "Property changed successfully" or nil,
		error = ok and nil or tostring(err),
		path = command.payload.path,
		property = propName,
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "MODIFY_FAILED"
	})
	appendLog(ok and ("Property " .. propName .. " changed at " .. command.payload.path) or ("modify_property failed: " .. tostring(err)))
end

executeCreateInstance = function(command)
	local parent = resolveInstanceByPath(command.payload.parentPath)
	if not parent then
		postCommandResult(command.id, false, {
			error = "Parent not found: " .. tostring(command.payload.parentPath),
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "PARENT_NOT_FOUND"
		})
		appendLog("create_instance falhou: parent invalido.")
		return
	end

	local className = command.payload.className
	local instanceName = command.payload.name or className
	local targetSegments = getInstancePathSegments(parent)
	table.insert(targetSegments, instanceName)
	if not isPathInsideActiveSyncMount(targetSegments) then
		postOutsideSyncMountResult(command, "create_instance", targetSegments)
		return
	end
	if duplicateMountRootIssueForPath(targetSegments) then
		postDuplicateMountRootResult(command, "create_instance", targetSegments)
		return
	end

	local okStartWaypoint, startWaypointErr = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP create instance: " .. className)
	end)
	if not okStartWaypoint then
		appendLog("create_instance waypoint warning: " .. tostring(startWaypointErr))
	end

	local ok, result = pcall(function()
		local okNew, newInstance = pcall(function()
			return Instance.new(className)
		end)
		if not okNew then
			error(newInstance)
		end
		local okName, nameErr = safeSetProperty(newInstance, "Name", instanceName, "MCP create name")
		if not okName then
			destroyUnexpectedChild(newInstance, "failed MCP create cleanup")
			error(nameErr)
		end

		for propName, propValue in pairs(command.payload.properties or {}) do
			local okProperty, propertyErr = setProperty(newInstance, propName, propValue)
			if not okProperty then
				destroyUnexpectedChild(newInstance, "failed MCP create cleanup")
				error(propertyErr)
			end
		end

		local okParent, parentErr = safeSetParent(newInstance, parent, "MCP create parent")
		if not okParent then
			destroyUnexpectedChild(newInstance, "failed MCP create cleanup")
			error(parentErr)
		end
		return newInstance
	end)
	local fullName = nil
	if ok and result then
		fullName = instanceName
		pcall(function()
			fullName = result:GetFullName()
		end)
		local okDoneWaypoint, doneWaypointErr = pcall(function()
			ChangeHistoryService:SetWaypoint("MCP create instance done")
		end)
		if not okDoneWaypoint then
			appendLog("create_instance completion waypoint warning: " .. tostring(doneWaypointErr))
		end
	end

	postCommandResult(command.id, ok, {
		result = ok and "Instance created successfully" or nil,
		fullName = ok and fullName or nil,
		error = ok and nil or tostring(result),
		parentPath = command.payload.parentPath,
		className = className,
		name = instanceName,
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "CREATE_FAILED"
	})
	appendLog(ok and ("Instance " .. className .. " created at " .. command.payload.parentPath) or ("create_instance failed: " .. tostring(result)))
end

executeDeleteInstance = function(command)
	local instance = resolveInstanceByPath(command.payload.path)
	if not instance then
		postCommandResult(command.id, false, {
			error = "Instance not found: " .. tostring(command.payload.path),
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "INSTANCE_NOT_FOUND"
		})
		appendLog("delete_instance falhou: caminho invalido.")
		return
	end

	local targetSegments = getInstancePathSegments(instance)
	if not isPathInsideActiveSyncMount(targetSegments) then
		postOutsideSyncMountResult(command, "delete_instance", targetSegments)
		return
	end
	if duplicateMountRootIssueForPath(targetSegments) then
		postDuplicateMountRootResult(command, "delete_instance", targetSegments)
		return
	end

	if instance.Parent == game then
		postCommandResult(command.id, false, {
			error = "Deleting game services directly is not allowed.",
			blocked = true,
			declined = false,
			confirmed = false,
			reasonCode = "DELETE_SERVICE_BLOCKED"
		})
		appendLog("delete_instance bloqueado: tentativa de deletar service.")
		return
	end
	if isProtectedSyncInstance(instance) then
		postCommandResult(command.id, false, {
			error = "Deleting protected instances such as Workspace.Terrain or player characters is not allowed.",
			blocked = true,
			declined = false,
			confirmed = false,
			reasonCode = "DELETE_PROTECTED_BLOCKED"
		})
		appendLog("delete_instance bloqueado: tentativa de deletar instancia protegida.")
		return
	end

	local fullName = instance:GetFullName()
	local ok, err = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP delete instance: " .. fullName)
		instance:Destroy()
		ChangeHistoryService:SetWaypoint("MCP delete instance done")
	end)

	postCommandResult(command.id, ok, {
		result = ok and "Instance deleted successfully" or nil,
		deletedPath = ok and fullName or nil,
		error = ok and nil or tostring(err),
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "DELETE_FAILED"
	})
	appendLog(ok and ("Instance deleted: " .. fullName) or ("delete_instance failed: " .. tostring(err)))
end

executeInsertModel = function(command)
	local query = tostring(command.payload.query or "")
	if query == "" then
		postCommandResult(command.id, false, {
			error = "Model query is required.",
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "INVALID_QUERY"
		})
		appendLog("insert_model falhou: query vazia.")
		return
	end

	local okSearch, results = pcall(function()
		return InsertService:GetFreeModels(query, 0)
	end)
	if not okSearch then
		postCommandResult(command.id, false, {
			error = tostring(results),
			blocked = false,
			declined = false,
			confirmed = true,
			reasonCode = "INSERT_SEARCH_FAILED"
		})
		appendLog("insert_model falhou na busca: " .. tostring(results))
		return
	end
	if type(results) ~= "table" or #results == 0 then
		postCommandResult(command.id, false, {
			error = "No free models were found for query: " .. query,
			blocked = false,
			declined = false,
			confirmed = true,
			reasonCode = "NO_MODEL_FOUND"
		})
		appendLog("insert_model nao encontrou resultados para: " .. query)
		return
	end

	local assetId = results[1].AssetId
	local okInsert, insertResult = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP insert model: " .. query)
		local model = InsertService:LoadAsset(assetId)
		local children = model:GetChildren()
		if #children == 0 then
			model:Destroy()
			error("Inserted asset did not return any children.")
		end
		local insertedName = children[1].Name
		for _, child in ipairs(children) do
			local okParent, parentErr = safeSetParent(child, workspace, "MCP insert model parent")
			if not okParent then
				error(parentErr)
			end
		end
		model:Destroy()
		ChangeHistoryService:SetWaypoint("MCP insert model done")
		return {
			insertedName = insertedName,
			insertedCount = #children,
			assetId = assetId
		}
	end)

	postCommandResult(command.id, okInsert, {
		result = okInsert and "Model inserted successfully" or nil,
		insertedName = okInsert and insertResult.insertedName or nil,
		insertedCount = okInsert and insertResult.insertedCount or nil,
		assetId = okInsert and insertResult.assetId or assetId,
		error = okInsert and nil or tostring(insertResult),
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = okInsert and nil or "INSERT_FAILED"
	})
	appendLog(okInsert and ("Model inserted from query: " .. query) or ("insert_model failed: " .. tostring(insertResult)))
end

executeDestructiveCommand = function(command)
	if command.type == "run_code" then
		executeRunCode(command)
		return
	end
	if command.type == "modify_property" then
		executeModifyProperty(command)
		return
	end
	if command.type == "create_instance" then
		executeCreateInstance(command)
		return
	end
	if command.type == "delete_instance" then
		executeDeleteInstance(command)
		return
	end
	if command.type == "insert_model" then
		executeInsertModel(command)
	end
end

local function destructiveConfirmationContent(command)
	if command.type == "run_code" then
		local code = tostring(command.payload.code or "")
		local preview = string.gsub(code, "\r", "")
		if #preview > 160 then
			preview = string.sub(preview, 1, 157) .. "..."
		end
		return {
			title = "Confirm Luau Execution",
			body = "Code length: " .. tostring(#code) .. " characters",
			detail = preview ~= "" and preview or "(empty code)",
			logMessage = "Luau execution awaiting confirmation."
		}
	end
	if command.type == "modify_property" then
		local propName = tostring(command.payload.property or "?")
		local instancePath = tostring(command.payload.path or "?")
		local valueDisplay = formatValueForDisplay(command.payload.value)
		return {
			title = "Confirm Property Change",
			body = "Instance: " .. instancePath,
			detail = "Property: " .. propName .. "\nNew value: " .. valueDisplay,
			logMessage = "Property change awaiting confirmation: " .. propName .. " at " .. instancePath
		}
	end
	if command.type == "create_instance" then
		local propertyCount = 0
		for _propName, _propValue in pairs(command.payload.properties or {}) do
			propertyCount = propertyCount + 1
		end
		return {
			title = "Confirm Instance Creation",
			body = "Parent: " .. tostring(command.payload.parentPath or "?"),
			detail = "Class: " .. tostring(command.payload.className or "?")
				.. "\nName: " .. tostring(command.payload.name or command.payload.className or "?")
				.. "\nInitial properties: " .. tostring(propertyCount),
			logMessage = "Instance creation awaiting confirmation at " .. tostring(command.payload.parentPath)
		}
	end
	if command.type == "delete_instance" then
		return {
			title = "Confirm Instance Deletion",
			body = "Target: " .. tostring(command.payload.path or "?"),
			detail = "This instance will be permanently destroyed in Roblox Studio.",
			logMessage = "Instance deletion awaiting confirmation: " .. tostring(command.payload.path)
		}
	end
	if command.type == "insert_model" then
		return {
			title = "Confirm Model Insert",
			body = "Marketplace query: " .. tostring(command.payload.query or "?"),
			detail = "The first free model match will be inserted into Workspace.",
			logMessage = "Model insert awaiting confirmation: " .. tostring(command.payload.query)
		}
	end
	return {
		title = "Confirm Privileged Action",
		body = "Action: " .. tostring(command.type or "?"),
		detail = "Accept to run this Studio operation.",
		logMessage = "Privileged action awaiting confirmation: " .. tostring(command.type)
	}
end

showDestructiveConfirmation = function(command)
	state.pendingDestructiveCommand = command
	state.pendingDestructiveSinceAt = currentIsoTime()
	if state.ui.propertyConfirmOverlay then
		local content = destructiveConfirmationContent(command)
		setTextIfPresent(state.ui.propertyConfirmTitle, content.title)
		setTextIfPresent(state.ui.propertyConfirmBody, content.body)
		setTextIfPresent(state.ui.propertyConfirmDetail, content.detail)
		state.ui.propertyConfirmOverlay.Visible = true
		updateStatus("waiting for confirmation")
	end
	showPluginWidget()
	appendLog(destructiveConfirmationContent(command).logMessage)
end

hideDestructiveConfirmation = function()
	if state.ui.propertyConfirmOverlay then
		state.ui.propertyConfirmOverlay.Visible = false
	end
	state.pendingDestructiveCommand = nil
	state.pendingDestructiveSinceAt = nil
end

acceptDestructiveAction = function()
	local command = state.pendingDestructiveCommand
	if not command then
		return
	end
	state.pendingDestructiveCommand = nil
	state.pendingDestructiveSinceAt = nil
	hideDestructiveConfirmation()
	executeDestructiveCommand(command)
end

declineDestructiveAction = function()
	local command = state.pendingDestructiveCommand
	if not command then
		return
	end
	state.pendingDestructiveCommand = nil
	state.pendingDestructiveSinceAt = nil
	hideDestructiveConfirmation()
	postCommandResult(command.id, false, {
		error = "Privileged action declined by user.",
		blocked = false,
		declined = true,
		confirmed = false,
		reasonCode = "DECLINED_BY_USER"
	})
	appendLog("Privileged action declined: " .. tostring(command.type))
end
