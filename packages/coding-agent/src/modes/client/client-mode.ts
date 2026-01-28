/**
 * Client mode: WebSocket client that connects to a remote pi server.
 *
 * Runs locally, renders TUI, sends user input to server.
 * Server handles LLM calls, tools, and file operations.
 *
 * Usage: pi --mode client --server ws://vm:9000
 */

import { execSync } from "child_process";
import * as readline from "readline";
import WebSocket from "ws";
import { getAgentDir, getModelsPath } from "../../config.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import { AuthStorage } from "../../core/auth-storage.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import { ModelRegistry } from "../../core/model-registry.js";
import { DefaultResourceLoader } from "../../core/resource-loader.js";
import { SessionManager } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { InteractiveMode } from "../interactive/interactive-mode.js";

import { ProxySession } from "./proxy-session.js";

/**
 * Check if the server URL is an exe.dev VM that needs authentication.
 */
function isExeDevUrl(url: string): boolean {
	return url.includes(".exe.xyz");
}

/**
 * Get the HTTP(S) URL from a WebSocket URL for cookie fetching.
 */
function wsToHttpUrl(wsUrl: string): string {
	return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

/**
 * Get exe.dev authentication cookie for a VM.
 *
 * Flow:
 * 1. Get magic link token via `ssh exe.dev browser`
 * 2. Verify magic link to get exe.dev session cookie
 * 3. Access VM to exchange exe.dev cookie for VM-specific cookie
 * 4. Return cookie header for WebSocket connection
 */
async function getExeDevCookie(serverUrl: string): Promise<string | undefined> {
	const httpUrl = wsToHttpUrl(serverUrl);
	const cookieFile = "/tmp/pi-exe-auth-cookies.txt";

	console.log("Authenticating with exe.dev...");

	// Step 1: Get magic link token from exe.dev
	let magicLinkToken: string;
	try {
		const output = execSync("ssh exe.dev browser", {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const match = output.match(/token=([A-Z0-9]+)/);
		if (!match) {
			console.error("Failed to extract magic link token from exe.dev");
			return undefined;
		}
		magicLinkToken = match[1];
	} catch {
		console.error("Failed to get exe.dev magic link. Make sure you have SSH access to exe.dev.");
		return undefined;
	}

	try {
		// Step 2: Verify magic link and save exe.dev cookie
		const verifyUrl = `https://exe.dev/auth/verify?token=${magicLinkToken}`;
		execSync(`curl -sL -c "${cookieFile}" "${verifyUrl}" -o /dev/null`, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Step 3: Access VM with exe.dev cookie, follow redirects to get VM cookie
		execSync(`curl -sL -b "${cookieFile}" -c "${cookieFile}" "${httpUrl}" -o /dev/null`, {
			encoding: "utf-8",
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Step 4: Read and parse the cookies file
		const cookieFileContent = execSync(`cat "${cookieFile}"`, { encoding: "utf-8" });
		const lines = cookieFileContent.split("\n");

		for (const line of lines) {
			if (line.includes("login-with-exe-")) {
				const parts = line.split("\t");
				if (parts.length >= 7) {
					const cookieName = parts[5];
					const cookieValue = parts[6].trim();
					console.log("Authentication successful");
					return `${cookieName}=${cookieValue}`;
				}
			}
		}

		console.error("Failed to get VM cookie from exe.dev auth flow");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Authentication error: ${message}`);
	}

	console.error("Try using SSH tunnel instead:");
	console.error(`  ssh -L 9000:localhost:9000 <vmname>.exe.xyz`);
	console.error(`  pi --mode client --server ws://localhost:9000`);
	return undefined;
}

export interface ClientModeOptions {
	serverUrl: string;
	initialMessage?: string;
	initialMessages?: string[];
}

/**
 * Run in client mode.
 * Connects to a remote server and provides local TUI interaction.
 */
export async function runClientMode(options: ClientModeOptions): Promise<never> {
	const { serverUrl } = options;

	// Get authentication cookie for exe.dev VMs
	let wsOptions: WebSocket.ClientOptions = {};
	if (isExeDevUrl(serverUrl)) {
		const cookie = await getExeDevCookie(serverUrl);
		if (cookie) {
			wsOptions = {
				headers: {
					Cookie: cookie,
				},
			};
		}
	}

	console.log(`Connecting to ${serverUrl}...`);

	const ws = new WebSocket(serverUrl, wsOptions);

	// Wait for connection
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => {
			console.log("Connected to server");
			resolve();
		});
		ws.on("error", (err) => {
			reject(new Error(`Failed to connect: ${err.message}`));
		});
	});

	// Set up local managers (for settings, model registry, etc.)
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const authStorage = new AuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true, // Extensions run on server
		noSkills: true,
		noPromptTemplates: true,
		noThemes: false, // Keep themes local
	});
	await resourceLoader.reload();

	// Create proxy session
	const proxySession = new ProxySession({
		send: (message) => ws.send(message),
		sessionManager,
		settingsManager,
		modelRegistry,
		resourceLoader,
	});

	// Handle messages from server
	ws.on("message", (data) => {
		proxySession.handleServerMessage(data.toString());
	});

	ws.on("close", (code, reason) => {
		console.log(`\nDisconnected from server (code: ${code}, reason: ${reason.toString() || "none"})`);
		process.exit(0);
	});

	ws.on("error", (err) => {
		console.error("Connection error:", err.message);
		process.exit(1);
	});

	// Get initial state from server
	await proxySession.refreshState();
	await proxySession.refreshMessages();

	// Initialize keybindings
	KeybindingsManager.create();

	// Run with either full TUI or simple readline mode
	if (process.stdin.isTTY) {
		await runInteractiveClient(proxySession, options);
	} else {
		await runSimpleClient(proxySession, options);
	}

	return new Promise(() => {});
}

/**
 * Run client with full TUI (InteractiveMode).
 * Requires TTY for keyboard input.
 */
async function runInteractiveClient(proxySession: ProxySession, options: ClientModeOptions): Promise<void> {
	// Cast ProxySession to AgentSession type for InteractiveMode
	// ProxySession implements the same interface
	const mode = new InteractiveMode(proxySession as any, {
		initialMessage: options.initialMessage,
		initialMessages: options.initialMessages,
	});
	await mode.run();
}

/**
 * Run client with simple readline interface.
 * Used when stdin is not a TTY (piped input).
 */
async function runSimpleClient(proxySession: ProxySession, options: ClientModeOptions): Promise<void> {
	// Simple event renderer
	proxySession.subscribe((event: AgentSessionEvent) => {
		renderEvent(event);
	});

	// Process initial messages
	if (options.initialMessage) {
		await proxySession.prompt(options.initialMessage);
		await waitForIdle(proxySession);
	}

	for (const msg of options.initialMessages ?? []) {
		await proxySession.prompt(msg);
		await waitForIdle(proxySession);
	}

	// Interactive loop with readline
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	rl.on("line", async (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		if (trimmed === "/quit" || trimmed === "/exit") {
			rl.close();
			process.exit(0);
		}

		await proxySession.prompt(trimmed);
	});

	rl.on("close", () => {
		process.exit(0);
	});
}

/**
 * Wait for agent to finish processing.
 */
async function waitForIdle(proxySession: ProxySession): Promise<void> {
	await proxySession.agent.waitForIdle();
}

/**
 * Render an agent event to stdout.
 */
function renderEvent(event: AgentSessionEvent): void {
	switch (event.type) {
		case "message_update": {
			// Handle streaming text deltas
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "text_delta") {
				process.stdout.write(streamEvent.delta);
			}
			break;
		}
		case "message_end":
			if (event.message.role === "assistant") {
				process.stdout.write("\n");
			}
			break;
		case "tool_execution_start":
			console.log(`\n[Tool: ${event.toolName}]`);
			break;
		case "tool_execution_end":
			if (event.isError) {
				console.log(`[Error: ${JSON.stringify(event.result).slice(0, 200)}]`);
			}
			break;
		case "agent_end":
			console.log("");
			break;
	}
}
