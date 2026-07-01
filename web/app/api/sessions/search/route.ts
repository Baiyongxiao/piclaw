import { NextResponse } from "next/server";
import { SqliteStore } from "@piclaw/coding-agent";

/**
 * Search sessions for a keyword within a workspace.
 *
 * GET /api/sessions/search?q=keyword&cwd=/path/to/project&limit=20
 *
 * Note: The entries_fts table exists but is contentless (content=''),
 * so UNINDEXED columns (session_id, entry_id) are not stored and cannot
 * be retrieved. We use LIKE on entries.content_json instead, which is
 * fast enough for the typical session volume (~thousands of entries).
 */

interface SearchRow {
  entry_id: string;
  session_id: string;
  session_name: string | null;
  first_message_json: string | null;
  modified_at: string;
  message_count: number;
  role: string | null;
  content_json: string | null;
}

export interface SearchMatch {
  sessionId: string;
  sessionName?: string;
  sessionModified: string;
  sessionMessageCount: number;
  entryId: string;
  role: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResponse {
  results: SearchMatch[];
}

/** Extract plain text from a message's content_json column */
function extractTextFromContentJson(jsonStr: string | null): string {
  if (!jsonStr) return "";
  try {
    const msg = JSON.parse(jsonStr);
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { text: string }) => b.text)
        .join(" ");
    }
    return "";
  } catch {
    return "";
  }
}

/** Build a snippet with context around the first keyword occurrence */
function buildSnippet(
  text: string,
  keyword: string,
  contextLen: number,
): { text: string; matchStart: number; matchEnd: number } {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  const idx = lower.indexOf(kw);

  if (idx === -1) {
    const truncated =
      text.length > contextLen * 2
        ? text.slice(0, contextLen * 2) + "…"
        : text;
    return { text: truncated, matchStart: 0, matchEnd: 0 };
  }

  const start = Math.max(0, idx - contextLen);
  const end = Math.min(text.length, idx + keyword.length + contextLen);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";

  const snippet = prefix + text.slice(start, end) + suffix;

  // Keyword position within the snippet text
  const offsetInSnippet = start > 0 ? idx - start + 1 : idx;

  return {
    text: snippet,
    matchStart: offsetInSnippet,
    matchEnd: offsetInSnippet + keyword.length,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const cwd = url.searchParams.get("cwd")?.trim();
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "20", 10),
    50,
  );

  if (!q || !cwd) {
    return NextResponse.json<SearchResponse>({ results: [] });
  }

  const store = new SqliteStore();
  try {
    const db = store.getDatabase();

    // Ensure an index exists for fast LIKE searches on entries
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_entries_type_session ON entries(type, session_id)",
    );

    const likePattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

    const rows = db
      .prepare(
        `SELECT
           e.id          AS entry_id,
           e.session_id,
           s.name        AS session_name,
           (SELECT content_json FROM entries e3
             WHERE e3.session_id = e.session_id
               AND e3.type = 'message'
               AND e3.role = 'user'
             ORDER BY e3.timestamp ASC, e3.rowid ASC
             LIMIT 1
           ) AS first_message_json,
           s.modified_at,
           (SELECT COUNT(*) FROM entries e2
             WHERE e2.session_id = e.session_id AND e2.type = 'message'
           ) AS message_count,
           e.role,
           e.content_json
         FROM entries e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'message'
           AND s.cwd = @cwd
           AND LOWER(e.content_json) LIKE @like ESCAPE '\\'
         ORDER BY s.modified_at DESC, e.timestamp ASC
         LIMIT @limit`,
      )
      .all({ cwd, like: likePattern, limit }) as SearchRow[];

    const results: SearchMatch[] = rows.map((row) => {
      const text = extractTextFromContentJson(row.content_json);
      const snippet = buildSnippet(text, q, 60);

      // Use session name if set, otherwise fall back to first user message
      let displayName: string | undefined = row.session_name || undefined;
      if (!displayName && row.first_message_json) {
        const firstMsgText = extractTextFromContentJson(row.first_message_json);
        if (firstMsgText) {
          const cleaned = firstMsgText.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
          displayName = cleaned.length > 100
            ? cleaned.slice(0, 100) + "…"
            : cleaned;
        }
      }

      return {
        sessionId: row.session_id,
        sessionName: displayName,
        sessionModified: row.modified_at,
        sessionMessageCount: row.message_count ?? 0,
        entryId: row.entry_id,
        role: row.role ?? "unknown",
        snippet: snippet.text,
        matchStart: snippet.matchStart,
        matchEnd: snippet.matchEnd,
      };
    });

    return NextResponse.json<SearchResponse>({ results });
  } finally {
    store.close();
  }
}
