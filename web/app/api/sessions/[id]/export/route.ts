import { NextResponse } from "next/server";
import { SessionManager, SqliteStore } from "@piclaw/coding-agent";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getAttachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return `<pre style="white-space: pre-wrap; margin: 0;">${escapeHtml(content)}</pre>`;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }) => {
        if (part.type === "text") return escapeHtml(part.text ?? "");
        if (part.type === "toolCall" || part.type === "tool_use") {
          return `<div style="color: #6b7280; font-style: italic; margin: 4px 0;">🔧 ${escapeHtml(part.name ?? "")}(${escapeHtml(JSON.stringify(part.arguments ?? {}))})</div>`;
        }
        if (part.type === "toolResult" || part.type === "tool_result") {
          return `<div style="color: #6b7280; margin: 4px 0;">📋 Tool result</div>`;
        }
        return escapeHtml(JSON.stringify(part));
      })
      .join("");
  }
  return escapeHtml(JSON.stringify(content));
}

function generateHtml(sm: SessionManager): string {
  const header = sm.getHeader();
  const entries = sm.getEntries();
  const leafId = sm.getLeafId();
  const cwd = header?.cwd ?? "";
  const name = sm.getSessionName();

  // Build path from leaf to root
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: typeof entries = [];
  let cur = leafId ? byId.get(leafId) : entries[entries.length - 1];
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  const messages = path.filter((e) => e.type === "message");

  const title = name ? escapeHtml(name) : `Session ${header?.id ?? ""}`;

  let body = messages
    .map((entry) => {
      const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (!msg) return "";
      const role = msg.role ?? "unknown";
      const roleClassMap: Record<string, string> = { user: "user", assistant: "assistant" };
      const roleLabelMap: Record<string, string> = { user: "You", assistant: "Pi" };
      const roleClass = roleClassMap[role] ?? "tool";
      const roleLabel = roleLabelMap[role] ?? "Tool";
      return `<div class="message ${roleClass}">
        <div class="role">${roleLabel}</div>
        <div class="content">${renderContent(msg.content)}</div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #fff; color: #333; }
  h1 { font-size: 1.2em; color: #666; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .meta { font-size: 0.85em; color: #999; margin-bottom: 20px; }
  .message { margin: 16px 0; padding: 12px; border-radius: 8px; }
  .message.user { background: #f0f7ff; }
  .message.assistant { background: #f9f9f9; }
  .message.tool { background: #f5f5f5; padding: 8px 12px; font-size: 0.9em; }
  .role { font-weight: 600; font-size: 0.85em; margin-bottom: 6px; color: #555; }
  .content { line-height: 1.6; }
  .content pre { background: #f4f4f4; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 0.9em; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">Working directory: ${escapeHtml(cwd)} &middot; ${messages.length} messages</div>
${body}
</body>
</html>`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const store = new SqliteStore();
    if (!store.readHeader(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(id);
    const html = generateHtml(sm);

    const fileName = `pi-session-${id}.html`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": getAttachmentDisposition(fileName),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Session export failed:", error);
    return NextResponse.json({ error: "Failed to export session" }, { status: 500 });
  }
}
