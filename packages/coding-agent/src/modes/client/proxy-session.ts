/**
 * ProxySession - AgentSession-like interface that proxies to a remote server.
 *
 * Used by client mode to make InteractiveMode work unchanged.
 * All operations are forwarded to the server via WebSocket RPC.
 */

import type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener, SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextUsage, ExtensionRunner } from "../../core/extensions/index.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { PromptTemplate } from "../../core/prompt-templates.js";
import type { ResourceLoader } from "../../core/resource-loader.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "../rpc/rpc-types.js";

export interface ProxySessionOptions {
	/** WebSocket send function */
	send: (message: string) => void;
	/** Session manager for local state */
	sessionManager: SessionManager;
	/** Settings manager for local settings */
	settingsManager: SettingsManager;
	/** Model registry for local model lookups */
	modelRegistry: ModelRegistry;
	/** Resource loader for local resources */
	resourceLoader: ResourceLoader;
}

/**
 * A proxy implementation that forwards AgentSession operations to a remote server.
 * Implements the subset of AgentSession interface needed by InteractiveMode.
 */
export class ProxySession {
	private _eventListeners: AgentSessionEventListener[] = [];
	private _pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private _requestId = 0;
	private _state: RpcSessionState | null = null;
	private _extensionUIHandlers = new Map<
		string,
		{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly resourceLoader: ResourceLoader;

	private _send: (message: string) => void;

	// Stub properties that InteractiveMode might access
	// These are populated from server state
	private _model: Model<any> | undefined;
	private _thinkingLevel: ThinkingLevel = "off";
	private _isStreaming = false;
	private _messages: AgentMessage[] = [];
	private _scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [];

	constructor(options: ProxySessionOptions) {
		this._send = options.send;
		this.sessionManager = options.sessionManager;
		this.settingsManager = options.settingsManager;
		this.modelRegistry = options.modelRegistry;
		this.resourceLoader = options.resourceLoader;
	}

	// =========================================================================
	// State (populated from server)
	// =========================================================================

	get model(): Model<any> | undefined {
		return this._model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this._thinkingLevel;
	}

	get isStreaming(): boolean {
		return this._isStreaming;
	}

	get isCompacting(): boolean {
		return this._state?.isCompacting ?? false;
	}

	get messages(): AgentMessage[] {
		return this._messages;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this._state?.steeringMode ?? "all";
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this._state?.followUpMode ?? "all";
	}

	get sessionFile(): string | undefined {
		return this._state?.sessionFile;
	}

	get sessionId(): string {
		return this._state?.sessionId ?? "";
	}

	get autoCompactionEnabled(): boolean {
		return this._state?.autoCompactionEnabled ?? true;
	}

	get pendingMessageCount(): number {
		return this._state?.pendingMessageCount ?? 0;
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel: ThinkingLevel }> {
		return this._scopedModels;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.resourceLoader.getPrompts().prompts;
	}

	// Stub agent for compatibility (minimal implementation)
	get agent(): Pick<Agent, "waitForIdle" | "state"> {
		const self = this;
		return {
			waitForIdle: async () => {
				// Poll state until not streaming
				while (self._isStreaming) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					await self.refreshState();
				}
			},
			get state(): AgentState {
				return {
					systemPrompt: "",
					messages: self._messages,
					model: self._model as Model<any>, // Cast - may be undefined initially
					thinkingLevel: self._thinkingLevel,
					isStreaming: self._isStreaming,
					tools: [],
					streamMessage: null,
					pendingToolCalls: new Set(),
				};
			},
		};
	}

	// State getter for compatibility with InteractiveMode
	get state(): AgentState {
		return this.agent.state;
	}

	// Stub extensionRunner (not supported in proxy mode)
	get extensionRunner(): ExtensionRunner | undefined {
		return undefined;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const listener of this._eventListeners) {
			listener(event);
		}
	}

	// =========================================================================
	// Message Handling (from server)
	// =========================================================================

	/**
	 * Handle a message received from the server.
	 * Routes to event listeners or pending request resolvers.
	 */
	handleServerMessage(data: string): void {
		try {
			const parsed = JSON.parse(data);

			// Handle RPC responses
			if (parsed.type === "response") {
				const response = parsed as RpcResponse;
				const pending = this._pendingRequests.get(response.id ?? "");
				if (pending) {
					this._pendingRequests.delete(response.id ?? "");
					if (response.success) {
						pending.resolve("data" in response ? response.data : undefined);
					} else {
						pending.reject(new Error(response.error));
					}
				}
				return;
			}

			// Handle extension UI requests (forward to registered handlers)
			if (parsed.type === "extension_ui_request") {
				const request = parsed as RpcExtensionUIRequest;
				this._handleExtensionUIRequest(request);
				return;
			}

			// Handle agent events (forward to subscribers)
			const event = parsed as AgentSessionEvent;
			this._handleAgentEvent(event);
			this._emit(event);
		} catch (e) {
			console.error("Failed to parse server message:", e);
		}
	}

	/**
	 * Update local state based on agent events.
	 */
	private _handleAgentEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this._isStreaming = true;
		} else if (event.type === "agent_end") {
			this._isStreaming = false;
			this._messages = event.messages;
		} else if (event.type === "message_end") {
			// Track messages as they complete
			if (!this._messages.some((m) => m === event.message)) {
				this._messages.push(event.message);
			}
		}
	}

	/**
	 * Handle extension UI requests from server.
	 * These need to be displayed by the client's TUI.
	 */
	private _handleExtensionUIRequest(request: RpcExtensionUIRequest): void {
		// Store the request for the UI to handle
		// The UI will call resolveExtensionUI when user responds
		const handler = this._extensionUIHandlers.get(request.id);
		if (handler) {
			// If there's already a handler, this is unexpected
			console.warn("Unexpected extension UI request with existing handler:", request.id);
		}
		// Emit as a custom event for the UI to handle
		// Cast needed because extension_ui_request is not in AgentSessionEvent
		this._emit({ ...request } as unknown as AgentSessionEvent);
	}

	/**
	 * Register a handler for an extension UI request.
	 */
	onExtensionUI(
		id: string,
		handler: { resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void },
	): void {
		this._extensionUIHandlers.set(id, handler);
	}

	/**
	 * Resolve an extension UI request (send response to server).
	 */
	resolveExtensionUI(response: RpcExtensionUIResponse): void {
		this._send(JSON.stringify(response));
		this._extensionUIHandlers.delete(response.id);
	}

	// =========================================================================
	// RPC Helpers
	// =========================================================================

	private _nextId(): string {
		return `req-${++this._requestId}`;
	}

	private _sendCommand<T>(command: RpcCommand): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = this._nextId();
			const commandWithId = { ...command, id };
			this._pendingRequests.set(id, { resolve, reject });
			this._send(JSON.stringify(commandWithId));
		});
	}

	private _sendCommandNoWait(command: RpcCommand): void {
		const id = this._nextId();
		const commandWithId = { ...command, id };
		this._send(JSON.stringify(commandWithId));
	}

	// =========================================================================
	// State Refresh
	// =========================================================================

	async refreshState(): Promise<void> {
		const state = await this._sendCommand<RpcSessionState>({ type: "get_state" });
		this._state = state;
		this._model = state.model;
		this._thinkingLevel = state.thinkingLevel;
		this._isStreaming = state.isStreaming;
	}

	async refreshMessages(): Promise<void> {
		const result = await this._sendCommand<{ messages: AgentMessage[] }>({ type: "get_messages" });
		this._messages = result.messages;
	}

	// =========================================================================
	// Prompting (proxied to server)
	// =========================================================================

	async prompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		this._sendCommandNoWait({
			type: "prompt",
			message: text,
			images: options?.images,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async steer(text: string): Promise<void> {
		await this._sendCommand({ type: "steer", message: text });
	}

	async followUp(text: string): Promise<void> {
		await this._sendCommand({ type: "follow_up", message: text });
	}

	async abort(): Promise<void> {
		await this._sendCommand({ type: "abort" });
	}

	async newSession(options?: { parentSession?: string }): Promise<boolean> {
		const result = await this._sendCommand<{ cancelled: boolean }>({
			type: "new_session",
			parentSession: options?.parentSession,
		});
		if (!result.cancelled) {
			this._messages = [];
		}
		return !result.cancelled;
	}

	// =========================================================================
	// Model (proxied to server)
	// =========================================================================

	async setModel(model: Model<any>): Promise<void> {
		await this._sendCommand({ type: "set_model", provider: model.provider, modelId: model.id });
		this._model = model;
	}

	async cycleModel(): Promise<{ model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | undefined> {
		const result = await this._sendCommand<{
			model: Model<any>;
			thinkingLevel: ThinkingLevel;
			isScoped: boolean;
		} | null>({ type: "cycle_model" });
		if (result) {
			this._model = result.model;
			this._thinkingLevel = result.thinkingLevel;
		}
		return result ?? undefined;
	}

	// =========================================================================
	// Thinking (proxied to server)
	// =========================================================================

	setThinkingLevel(level: ThinkingLevel): void {
		this._sendCommandNoWait({ type: "set_thinking_level", level });
		this._thinkingLevel = level;
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		// Send command and update local state optimistically
		this._sendCommandNoWait({ type: "cycle_thinking_level" });
		// The actual level will be updated via state refresh or events
		return undefined;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this._model?.reasoning) return ["off"];
		return ["off", "minimal", "low", "medium", "high"];
	}

	supportsThinking(): boolean {
		return !!this._model?.reasoning;
	}

	supportsXhighThinking(): boolean {
		return false; // Simplified for MVP
	}

	// =========================================================================
	// Queue Modes (proxied to server)
	// =========================================================================

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._sendCommandNoWait({ type: "set_steering_mode", mode });
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._sendCommandNoWait({ type: "set_follow_up_mode", mode });
	}

	// =========================================================================
	// Compaction (proxied to server)
	// =========================================================================

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._sendCommand({ type: "compact", customInstructions });
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this._sendCommandNoWait({ type: "set_auto_compaction", enabled });
	}

	// =========================================================================
	// Retry (proxied to server)
	// =========================================================================

	setAutoRetryEnabled(enabled: boolean): void {
		this._sendCommandNoWait({ type: "set_auto_retry", enabled });
	}

	abortRetry(): void {
		this._sendCommandNoWait({ type: "abort_retry" });
	}

	// =========================================================================
	// Bash (proxied to server)
	// =========================================================================

	async executeBash(command: string): Promise<BashResult> {
		return this._sendCommand({ type: "bash", command });
	}

	abortBash(): void {
		this._sendCommandNoWait({ type: "abort_bash" });
	}

	// =========================================================================
	// Session (proxied to server)
	// =========================================================================

	getSessionStats(): SessionStats {
		// This is synchronous in AgentSession but we can't make it async here
		// Return placeholder - real stats come from server via get_session_stats command
		return {
			sessionFile: this._state?.sessionFile,
			sessionId: this._state?.sessionId ?? "",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: this._messages.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const result = await this._sendCommand<{ path: string }>({ type: "export_html", outputPath });
		return result.path;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		const result = await this._sendCommand<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
		return !result.cancelled;
	}

	async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const result = await this._sendCommand<{ text: string; cancelled: boolean }>({ type: "fork", entryId });
		return { selectedText: result.text, cancelled: result.cancelled };
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		// This would need async, return empty for now
		return [];
	}

	getLastAssistantText(): string | null {
		// Return from local messages
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const msg = this._messages[i];
			if (msg.role === "assistant") {
				const content = msg.content;
				for (const block of content) {
					if (block.type === "text") {
						return block.text;
					}
				}
			}
		}
		return null;
	}

	// =========================================================================
	// Queue Access
	// =========================================================================

	getSteeringMessages(): readonly string[] {
		return [];
	}

	getFollowUpMessages(): readonly string[] {
		return [];
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		return { steering: [], followUp: [] };
	}

	// =========================================================================
	// Extensions (stubs - not fully supported in proxy mode)
	// =========================================================================

	async bindExtensions(_bindings: unknown): Promise<void> {
		// Extensions run on server, not client
	}

	// =========================================================================
	// Context Usage
	// =========================================================================

	getContextUsage(): ContextUsage {
		return {
			tokens: 0,
			contextWindow: this._model?.contextWindow ?? 0,
			percent: 0,
			usageTokens: 0,
			trailingTokens: 0,
			lastUsageIndex: null,
		};
	}

	// =========================================================================
	// Scoped Models
	// =========================================================================

	setScopedModels(models: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>): void {
		this._scopedModels = models;
	}

	// =========================================================================
	// Tree Navigation (proxied)
	// =========================================================================

	async navigateTree(
		_targetId: string,
		_options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean; editorText?: string }> {
		// Not fully implemented for MVP
		return { cancelled: true };
	}

	// =========================================================================
	// Dispose
	// =========================================================================

	dispose(): void {
		this._eventListeners = [];
		this._pendingRequests.clear();
	}
}
