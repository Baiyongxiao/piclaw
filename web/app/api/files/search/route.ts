import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAllowedRoots, isPathAllowed, IGNORED_NAMES, IGNORED_SUFFIXES, normalizeCwd } from "@/lib/file-access";

export interface FileSearchResult {
  name: string;
  fullPath: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export interface FileSearchResponse {
  results: FileSearchResult[];
}

/** Recursively collect files/dirs whose name matches the query */
function collectMatches(
  dirPath: string,
  query: string,
  cwd: string,
  results: FileSearchResult[],
  depth: number,
  maxResults: number,
  maxDepth: number,
): void {
  if (results.length >= maxResults || depth > maxDepth) return;

  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return;
  }

  const lowerQuery = query.toLowerCase();

  for (const name of names) {
    if (results.length >= maxResults) break;

    // Skip ignored patterns
    if (IGNORED_NAMES.has(name)) continue;
    if (IGNORED_SUFFIXES.some((s) => name.endsWith(s))) continue;

    const fullPath = path.join(dirPath, name);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    const relativePath = path.relative(cwd, fullPath);

    // Name match (case-insensitive)
    if (name.toLowerCase().includes(lowerQuery)) {
      results.push({
        name,
        fullPath,
        relativePath,
        isDir: stat.isDirectory(),
        size: stat.isFile() ? stat.size : 0,
        modified: stat.mtime.toISOString(),
      });
    }

    // Recurse into directories
    if (stat.isDirectory()) {
      collectMatches(fullPath, query, cwd, results, depth + 1, maxResults, maxDepth);
    }
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    const rawCwd = url.searchParams.get("cwd")?.trim();

    if (!q || !rawCwd) {
      return NextResponse.json<FileSearchResponse>({ results: [] });
    }

    // Normalize cwd (resolve ~, ~/, relative paths)
    const cwd = normalizeCwd(rawCwd);

    // Security: resolve symlinks before verifying path
    let realCwd: string;
    try {
      realCwd = fs.realpathSync(cwd);
    } catch {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(realCwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Validate cwd exists and is a directory
    try {
      if (!fs.statSync(realCwd).isDirectory()) {
        return NextResponse.json({ error: "Not a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }

    // Guard against NaN/negative limit values
    const limitParam = parseInt(url.searchParams.get("limit") ?? "30", 10);
    const maxResults = Math.min(
      Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 30,
      100,
    );
    const maxDepth = 8;

    const results: FileSearchResult[] = [];
    collectMatches(realCwd, q, realCwd, results, 0, maxResults, maxDepth);

    // Sort: directories first, then by relative path alphabetically
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.relativePath.localeCompare(b.relativePath);
    });

    return NextResponse.json<FileSearchResponse>({ results });
  } catch (error) {
    console.error("File search failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
