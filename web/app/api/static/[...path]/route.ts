import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const MIME_TYPES: Record<string, string> = {
  // Web
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  xml: "application/xml",
  txt: "text/plain",
  csv: "text/csv",

  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",

  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",

  // Audio/Video
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",

  // Other
  pdf: "application/pdf",
  map: "application/json",
  wasm: "application/wasm",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * GET /api/static/<base64-workspace>/<relative-path>
 *
 * Serves static files from a workspace directory. The first path segment
 * is a URL-safe base64 encoded workspace path. All subsequent segments
 * form the relative file path within that workspace.
 *
 * This enables HTML file previews where <link>, <script>, <img> etc.
 * with relative paths resolve correctly against the workspace directory.
 *
 * Security: the workspace path must be within allowed roots (session cwds).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;

    if (!segments || segments.length < 1) {
      return NextResponse.json({ error: "Missing workspace path" }, { status: 400 });
    }

    // Decode URL-safe base64 workspace path
    const workspaceEncoded = segments[0];
    let workspaceDir: string;
    try {
      // Reverse URL-safe encoding: '-' -> '+', '_' -> '/'
      const b64 = workspaceEncoded.replace(/-/g, '+').replace(/_/g, '/');
      workspaceDir = Buffer.from(b64, 'base64').toString('utf-8');
      if (!workspaceDir) throw new Error("empty");
    } catch {
      return NextResponse.json({ error: "Invalid workspace encoding" }, { status: 400 });
    }

    // Validate workspace is an absolute path
    if (!path.isAbsolute(workspaceDir)) {
      return NextResponse.json({ error: "Workspace path must be absolute" }, { status: 400 });
    }

    // Resolve symlinks in the workspace path to prevent symlink traversal
    let normWorkspace: string;
    try {
      normWorkspace = fs.realpathSync(workspaceDir);
    } catch {
      return NextResponse.json({ error: "Workspace not accessible" }, { status: 403 });
    }

    // Security: check against allowed roots
    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(normWorkspace, allowedRoots)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Build the relative file path from remaining segments
    const relPath = segments.slice(1).join("/");
    const name = path.basename(relPath);
    if (!name || name.endsWith(".")) {
      // ".." segments get collapsed by path.join, but reject basic traversal
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    // Resolve the full file path
    const fullPath = path.resolve(normWorkspace, relPath);

    // Additional security: ensure resolved path is within workspace
    const rel = path.relative(normWorkspace, fullPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Check file exists (async)
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 404 });
      }

      // Serve the file (async read, with 10 MB limit for memory safety)
      if (stat.size > 10 * 1024 * 1024) {
        // For large files, convert Node.js stream to Web ReadableStream
        const nodeStream = fs.createReadStream(fullPath);
        const mimeType = getMimeType(fullPath);
        // Convert Node.js Readable to Web ReadableStream for NextResponse compatibility
        const webStream = new ReadableStream({
          start(controller) {
            nodeStream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => {
              console.error("Stream error serving", fullPath, err);
              controller.error(err);
            });
          },
        });
        return new NextResponse(webStream, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(stat.size),
            "Cache-Control": "public, max-age=10",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const content = await fs.promises.readFile(fullPath);
      const mimeType = getMimeType(fullPath);

      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(stat.size),
          "Cache-Control": "public, max-age=10",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  } catch (error) {
    console.error("Static file serve error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
