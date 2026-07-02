import { NextResponse } from "next/server";
import { SessionManager, SqliteStore } from "@piclaw/coding-agent";
import { buildSessionContext } from "@/lib/session-reader";
import { MESSAGE_PAGE_SIZE } from "@/lib/constants";

function sliceContextMessages(
  fullMessages: readonly { role: string }[],
  fullEntryIds: readonly string[],
  size: number,
) {
  const total = fullMessages.length;
  if (total <= size) {
    return {
      messages: fullMessages,
      entryIds: fullEntryIds,
      totalMessageCount: total,
      oldestLoadedEntryId: fullEntryIds[0] ?? null,
    };
  }
  return {
    messages: fullMessages.slice(-size),
    entryIds: fullEntryIds.slice(-size),
    totalMessageCount: total,
    oldestLoadedEntryId: fullEntryIds[total - size] ?? null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;

  try {
    const store = new SqliteStore();
    if (!store.readHeader(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(id);
    const context = buildSessionContext(sm.getEntries() as never, leafId);

    const paginated = sliceContextMessages(context.messages, context.entryIds, MESSAGE_PAGE_SIZE);

    return NextResponse.json({
      context: {
        ...context,
        messages: paginated.messages,
        entryIds: paginated.entryIds,
      },
      totalMessageCount: paginated.totalMessageCount,
      oldestLoadedEntryId: paginated.oldestLoadedEntryId,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
