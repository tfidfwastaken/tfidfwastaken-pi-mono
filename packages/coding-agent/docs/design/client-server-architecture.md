# Pi Client-Server Architecture (MVP)

## Problem

SSH-based remote usage has lag, crashes, and flaky mounts.

## Solution

WebSocket-based client-server split:
- **Server**: Runs on VM, executes everything (LLM, tools, files)
- **Client**: Runs locally, renders TUI, sends user input

## Key Insight

RPC mode already defines the complete protocol. The MVP is:
1. Server = RPC mode over WebSocket instead of stdin/stdout
2. Client = WebSocket connection feeding events to existing TUI

---

## Implementation

### Server Mode (`--mode server`)

```typescript
// src/modes/server/server-mode.ts
import { WebSocketServer } from "ws";
import { runRpcMode } from "../rpc/rpc-mode.js";

export async function runServerMode(session: AgentSession, port: number): Promise<never> {
  const wss = new WebSocketServer({ port });
  
  wss.on("connection", (ws) => {
    // Pipe WebSocket to RPC handler
    // ws.on("message") → parse JSON → handle like RPC stdin
    // RPC output → ws.send()
  });
}
```

### Client Mode (`--mode client`)

```typescript
// src/modes/client/client-mode.ts
import WebSocket from "ws";

export async function runClientMode(serverUrl: string): Promise<never> {
  const ws = new WebSocket(serverUrl);
  
  // Create a "proxy" AgentSession that:
  // - Sends commands to server via WebSocket
  // - Receives events and emits to subscribers
  
  // Pass to InteractiveMode as normal
  const mode = new InteractiveMode(proxySession);
  await mode.run();
}
```

---

## Files to Create

1. `src/modes/server/server-mode.ts` - WebSocket server wrapping RPC logic
2. `src/modes/client/client-mode.ts` - WebSocket client + proxy session
3. `src/modes/client/proxy-session.ts` - AgentSession interface over WebSocket

## Files to Modify

1. `src/main.ts` - Add `--mode server` and `--mode client`
2. `src/cli/args.ts` - Add `--port` and `--server` options

---

## CLI

```bash
# On VM
pi --mode server --port 9000

# On laptop  
pi --mode client --server ws://vm:9000
```

---

## What's Deferred

- Auth (use SSH tunnel for now)
- Reconnection logic (just restart client)
- Extension TUI components (use RPC UI protocol, already works)
- Event replay on reconnect

---

## Scope

~500 lines of new code. Reuses:
- Entire RPC protocol and command handling
- InteractiveMode unchanged
- All existing event types
