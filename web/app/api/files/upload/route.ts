import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAllowedRoots, isPathAllowed, IGNORED_NAMES, IGNORED_SUFFIXES } from "@/lib/file-access";

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const rawTargetDir = formData.get("targetDir") as string || "";

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    // Check target exists and resolve symlinks (to prevent symlink traversal)
    if (!fs.existsSync(rawTargetDir)) {
      return NextResponse.json({ error: "Target directory does not exist" }, { status: 404 });
    }
    const targetDir = fs.realpathSync(rawTargetDir);

    // Security check on resolved real path
    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(targetDir, allowedRoots)) {
      return NextResponse.json({ error: "Access denied: target directory not allowed" }, { status: 403 });
    }

    const targetStat = fs.statSync(targetDir);
    if (!targetStat.isDirectory()) {
      return NextResponse.json({ error: "Target is not a directory" }, { status: 400 });
    }

    const saved: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const fileName = file.name;

      // Filter out ignored names
      if (IGNORED_NAMES.has(fileName) || IGNORED_SUFFIXES.some((s) => fileName.endsWith(s))) {
        skipped.push(fileName);
        continue;
      }

      // Basic path traversal protection
      const safeName = path.basename(fileName);
      if (safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
        skipped.push(fileName);
        continue;
      }

      const destPath = path.join(targetDir, safeName);

      // Don't overwrite directories
      if (fs.existsSync(destPath)) {
        const existingStat = fs.statSync(destPath);
        if (existingStat.isDirectory()) {
          errors.push(`${safeName}: path is an existing directory`);
          continue;
        }
      }

      // Check file size before reading into memory
      if (file.size > MAX_UPLOAD_SIZE) {
        errors.push(`${safeName}: file exceeds maximum upload size (${MAX_UPLOAD_SIZE / (1024 * 1024)} MB)`);
        continue;
      }

      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.promises.writeFile(destPath, buffer);
        saved.push(safeName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`${safeName}: ${msg}`);
        console.error(`Upload error for ${destPath}:`, err);
      }
    }

    return NextResponse.json({
      success: true,
      saved,
      skipped,
      errors,
      count: saved.length,
      targetDir: rawTargetDir,
    });
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
