/**
 * Migrate existing .jsonl session files to SQLite.
 *
 * Usage: npx tsx scripts/migrate-jsonl-to-sqlite.ts
 *
 * Scans ~/.pi/agent/sessions/ for .jsonl files and imports each session
 * into ~/.pi/agent/sessions.db via SqliteStore. Skips sessions that
 * already exist in the database.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore } from "../packages/coding-agent/src/core/session-store-sqlite.ts";
import type { FileEntry, SessionHeader } from "../packages/coding-agent/src/core/session-store.ts";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

async function findAllJsonlFiles(dir: string): Promise<string[]> {
	const results: string[] = [];

	if (!existsSync(dir)) return results;

	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			const subFiles = await findAllJsonlFiles(fullPath);
			results.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			results.push(fullPath);
		}
	}
	return results;
}

function parseJsonlFile(filePath: string): FileEntry[] {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.trim().split("\n");
	const entries: FileEntry[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			entries.push(entry);
		} catch (e) {
			console.error(`  ⚠️  Failed to parse line in ${filePath}: ${(e as Error).message}`);
		}
	}
	return entries;
}

async function migrate() {
	const store = new SqliteStore();
	console.log(`📁 SQLite database: ${store.getDatabasePath()}`);
	console.log(`📂 Scanning session directory: ${SESSIONS_DIR}`);

	const files = await findAllJsonlFiles(SESSIONS_DIR);
	console.log(`📄 Found ${files.length} .jsonl files\n`);

	let imported = 0;
	let skipped = 0;
	let errors = 0;

	for (const filePath of files) {
		const fileName = filePath.replace(SESSIONS_DIR, "");
		const entries = parseJsonlFile(filePath);

		if (entries.length === 0) {
			console.log(`  ⚠️  ${fileName} — empty file, skip`);
			skipped++;
			continue;
		}

		const header = entries.find((e): e is SessionHeader => e.type === "session");
		if (!header) {
			console.log(`  ⚠️  ${fileName} — no session header, skip`);
			skipped++;
			continue;
		}

		const sessionId = header.id;

		// Check if this session already exists in SQLite
		if (store.sessionFileExists(sessionId)) {
			console.log(`  ⏭  ${sessionId} — already exists, skip`);
			skipped++;
			continue;
		}

		try {
			// Wrap the entire file import in a transaction to prevent orphan sessions
			// on partial failure
			const db = store.getDatabase();
			const importTx = db.transaction(() => {
				store.createSessionFile(sessionId, header);

				let entryCount = 0;
				for (const entry of entries) {
					if (entry.type === "session") continue;
					store.appendToFile(sessionId, entry as FileEntry);
					entryCount++;
				}
				return entryCount;
			});

			const entryCount = importTx();

			const fileStat = statSync(filePath);
			const fileMtime = fileStat.mtime.toISOString();
			console.log(`  ✅ ${sessionId} — ${entryCount} entries (${fileName.split("/").pop()}) [${fileMtime}]`);
			imported++;
		} catch (e) {
			console.error(`  ❌ ${sessionId} — import failed: ${(e as Error).message}`);
			errors++;
		}
	}

	console.log(`\n📊 Summary: imported ${imported}, skipped ${skipped}, errors ${errors}`);

	// Verify
	const dbFileCount = await store.listAllSessions();
	console.log(`📊 Sessions in SQLite: ${dbFileCount.length}`);

	store.close();
}

migrate().catch((e) => {
	console.error("Migration failed:", e);
	process.exit(1);
});
