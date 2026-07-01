import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { allowFileRoot, normalizeCwd } from "@/lib/file-access";

// POST /api/cwd/validate  body: { cwd: string, currentCwd?: string }
// Validates a candidate workspace before the UI selects it.
// If cwd is a relative path, it is resolved against currentCwd.
// Returns { exists: false, cwd } if the directory doesn't exist,
// so the UI can offer to create it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; currentCwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const currentCwd = typeof body.currentCwd === "string" ? body.currentCwd.trim() : undefined;

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeCwd(cwd, currentCwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch (e) {
      // Only treat ENOENT as "directory doesn't exist";
      // other errors (EACCES, ENOTDIR, etc.) should propagate.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return NextResponse.json({ exists: false, cwd: normalizedCwd });
      }
      throw e;
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    return NextResponse.json({ exists: true, cwd: normalizedCwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
