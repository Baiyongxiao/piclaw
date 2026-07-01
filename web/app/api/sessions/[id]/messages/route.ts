import { NextRequest, NextResponse } from "next/server";
import { SessionManager } from "@piclaw/coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Parse and clamp a limit query param; falls back to default if invalid. */
function parseLimitParam(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/** Return the last `limit` messages (for initial load or cursor-not-found fallback). */
function lastPage(
  messages: readonly { role: string }[],
  entryIds: readonly string[],
  limit: number,
): { messages: { role: string }[]; entryIds: string[]; hasMore: boolean; nextCursor: string | null } {
  const total = messages.length;
  if (total <= limit) {
    return { messages: messages as unknown as { role: string }[], entryIds: entryIds as unknown as string[], hasMore: false, nextCursor: null };
  }
  return {
    messages: messages.slice(-limit) as unknown as { role: string }[],
    entryIds: entryIds.slice(-limit) as unknown as string[],
    hasMore: true,
    nextCursor: entryIds[total - limit] ?? null,
  };
}

/**
 * GET /api/sessions/[id]/messages?beforeEntryId=<entryId>&limit=20
 *
 * Cursor-based pagination: returns `limit` messages that come BEFORE
 * the given entry ID in the session context.
 *
 * Response:
 *   { messages, entryIds, hasMore, nextCursor }
 *
 * - `hasMore` is true if there are more messages before this page.
 * - `nextCursor` is the entryId of the oldest message in this page,
 *   to be used as `beforeEntryId` for the next request.
 * - If `beforeEntryId` is omitted, returns the last `limit` messages.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const searchParams = req.nextUrl.searchParams;
  const beforeEntryId = searchParams.get("beforeEntryId");
  const limitStr = searchParams.get("limit");
  const limit = parseLimitParam(limitStr, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries() as never;
    const leafId = sm.getLeafId();
    const context = buildSessionContext(entries, leafId);

    const { messages, entryIds } = context;
    const total = messages.length;

    // If no beforeEntryId, return the last `limit` messages
    if (!beforeEntryId) {
      return NextResponse.json(lastPage(messages, entryIds, limit));
    }

    // Find the index of beforeEntryId in entryIds
    const endIdx = entryIds.indexOf(beforeEntryId);
    if (endIdx === -1) {
      // Entry not found in current context — the session tree may have changed.
      // Return the last `limit` messages as a fallback.
      return NextResponse.json(lastPage(messages, entryIds, limit));
    }

    if (endIdx === 0) {
      // Already at the beginning
      return NextResponse.json({ messages: [], entryIds: [], hasMore: false, nextCursor: null });
    }

    const startIdx = Math.max(0, endIdx - limit);
    const pageMessages = messages.slice(startIdx, endIdx);
    const pageEntryIds = entryIds.slice(startIdx, endIdx);
    const hasMore = startIdx > 0;
    const nextCursor = hasMore ? entryIds[startIdx] : null;

    return NextResponse.json({ messages: pageMessages, entryIds: pageEntryIds, hasMore, nextCursor });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
