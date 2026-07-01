import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@piclaw/coding-agent";

export const dynamic = "force-dynamic";

// Maximum lifetime for an SSE connection: 15 minutes.
// After this, the stream is force-closed to prevent resource leaks
// when client disconnect is not reliably detected (e.g., half-open TCP,
// proxy timeouts, or Next.js abort signal edge cases).
const SSE_MAX_LIFETIME_MS = 15 * 60 * 1000;

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    try {
      ({ session } = await startRpcSession(id, filePath, cwd));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      // ====================================================================
      // Backpressure-aware event handler
      //
      // When the agent generates large content (e.g., writing a big file),
      // message_update events fire rapidly with growing JSON payloads.
      // If the client can't read the SSE stream as fast as the server
      // produces events, the default ReadableStream queue grows unboundedly
      // (controller.enqueue does NOT block or enforce highWaterMark).
      // This caused memory to climb >1.5 GB during active streaming.
      //
      // Fix: for message_update (the high-frequency, high-volume event),
      // skip the enqueue when the stream queue is full (desiredSize <= 0).
      // The next message_update or the final message_end will carry the
      // complete content, so the client loses no data — it just receives
      // sparser updates until it catches up.
      //
      // Critical state-transition events (message_end, agent_end, etc.)
      // always enqueue because they happen once per turn and are small.
      // ====================================================================
      const unsubscribe = session.onEvent((event) => {
        // Backpressure guard: skip message_update when client is behind
        if (event.type === "message_update" && controller.desiredSize != null && controller.desiredSize <= 0) {
          // Client too slow — drop this update. The next one or
          // message_end will bring the client up to date.
          return;
        }
        encode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Safety: force-close stream after max lifetime to prevent indefinite leaks
      const maxLifetime = setTimeout(() => {
        cleanup();
      }, SSE_MAX_LIFETIME_MS);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        clearTimeout(maxLifetime);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
