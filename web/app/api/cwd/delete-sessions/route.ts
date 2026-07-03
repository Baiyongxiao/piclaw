import { NextResponse } from "next/server";
import { SqliteStore } from "@piclaw/coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";

// POST /api/cwd/delete-sessions  body: { cwd: string }
// Deletes all sessions associated with the given cwd from the database,
// and kills any running RPC agents for those sessions.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string };
    const targetCwd = body.cwd;
    if (!targetCwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    const store = new SqliteStore();
    const db = store.getDatabase();

    // Find all session IDs with this cwd
    const rows = db
      .prepare("SELECT id FROM sessions WHERE cwd = ?")
      .all(targetCwd) as { id: string }[];

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, deletedCount: 0 });
    }

    const tx = db.transaction(() => {
      for (const row of rows) {
        // Kill running agent if any
        getRpcSession(row.id)?.destroy();
        // Delete full-text search entries
        db.prepare("DELETE FROM entries_fts WHERE session_id = ?").run(row.id);
        // Delete session entries
        db.prepare("DELETE FROM entries WHERE session_id = ?").run(row.id);
        // Delete session
        db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      }
    });
    tx();

    return NextResponse.json({ ok: true, deletedCount: rows.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
