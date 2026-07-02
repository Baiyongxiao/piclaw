import Database, { type BetterSqlite3Database } from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { randomUUID } from "crypto";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type {
	SessionStore,
	SessionHeader,
	SessionEntry,
	FileEntry,
	SessionInfo,
	SessionListProgress,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
	ModelChangeEntry,
	CompactionEntry,
	BranchSummaryEntry,
	CustomEntry,
	LabelEntry,
	SessionInfoEntry,
	CustomMessageEntry,
} from "./session-store.ts";

// ============================================================================
// SqliteStore — stores sessions in a SQLite database with FTS5 full-text search
// ============================================================================

export class SqliteStore implements SessionStore {
	private db: BetterSqlite3Database;
	private dbPath: string;

	/**
	 * Shared default store singleton.
	 * All SessionManager operations within the same process share a single
	 * database connection, eliminating cross-connection WAL visibility issues
	 * that could cause intermittent failures when switching sessions.
	 */
	private static defaultStore: SqliteStore | null = null;

	/**
	 * Get or create the shared default store instance.
	 * Uses the default agent sessions database path.
	 */
	static getDefault(): SqliteStore {
		if (!SqliteStore.defaultStore) {
			SqliteStore.defaultStore = new SqliteStore();
		}
		return SqliteStore.defaultStore;
	}

	/**
	 * Reset the shared default store (for testing only).
	 */
	static resetDefaultForTesting(): void {
		if (SqliteStore.defaultStore) {
			SqliteStore.defaultStore.close();
			SqliteStore.defaultStore = null;
		}
	}

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? join(getDefaultAgentDir(), "sessions.db");
		const dir = dirname(this.dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const DB = Database;
		this.db = new DB(this.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.initSchema();
	}

	/**
	 * Close the database connection gracefully.
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Get the underlying database path.
	 */
	getDatabasePath(): string {
		return this.dbPath;
	}

	/**
	 * Return a reference to the database for advanced usage (e.g., raw queries).
	 */
	getDatabase(): BetterSqlite3Database {
		return this.db;
	}

	// ── Schema initialization ──────────────────────────────────────────

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id              TEXT PRIMARY KEY,
				cwd             TEXT NOT NULL DEFAULT '',
				created_at      TEXT NOT NULL,
				modified_at     TEXT NOT NULL,
				parent_session  TEXT,
				name            TEXT
			);

			CREATE TABLE IF NOT EXISTS entries (
				id           TEXT PRIMARY KEY,
				session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				parent_id    TEXT,
				type         TEXT NOT NULL,
				timestamp    TEXT NOT NULL,

				-- For message entries
				role         TEXT,
				content_json TEXT,       -- full JSON of the entry body

				-- For custom / custom_message entries
				custom_type  TEXT,

				-- For labels
				target_id    TEXT,
				label        TEXT,

				-- For model_change
				provider     TEXT,
				model_id     TEXT,

				-- For thinking_level_change
				thinking_level TEXT,

				-- For compaction
				summary      TEXT,
				first_kept_entry_id TEXT,
				tokens_before INTEGER,

				-- For branch_summary
				from_id      TEXT,
				from_hook    INTEGER DEFAULT 0,

				-- Display flag for custom_message
				display      INTEGER DEFAULT 1
			);

			CREATE INDEX IF NOT EXISTS idx_entries_session
				ON entries(session_id, timestamp);

			CREATE INDEX IF NOT EXISTS idx_entries_type
				ON entries(session_id, type);

			CREATE INDEX IF NOT EXISTS idx_entries_parent
				ON entries(session_id, parent_id);

			CREATE INDEX IF NOT EXISTS idx_sessions_cwd
				ON sessions(cwd);

			-- Full-text search virtual table
			CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
				text_content,
				session_id UNINDEXED,
				entry_id UNINDEXED,
				content='',
				tokenize='unicode61'
			);
		`);
	}

	// ── Instance-level operations ──────────────────────────────────────

	loadEntries(sessionFile: string): FileEntry[] {
		// sessionFile is the session id for SqliteStore
		const sessionId = pathToSessionId(sessionFile);
		const header = this.readSessionById(sessionId);
		if (!header) return [];

		const rows = this.db
			.prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC")
			.all(sessionId) as unknown as EntryRow[];

		const entries: FileEntry[] = [header];
		for (const row of rows) {
			const entry = this.rowToEntry(row);
			if (entry) entries.push(entry);
		}
		return entries;
	}

	readHeader(sessionFile: string): SessionHeader | null {
		const sessionId = pathToSessionId(sessionFile);
		return this.readSessionById(sessionId);
	}

	sessionFileExists(sessionFile: string): boolean {
		const sessionId = pathToSessionId(sessionFile);
		const row = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
		return row !== undefined;
	}

	appendToFile(sessionFile: string, entry: SessionEntry): void {
		const sessionId = pathToSessionId(sessionFile);
		this.insertEntry(sessionId, entry);
		this.db.prepare("UPDATE sessions SET modified_at = ? WHERE id = ?").run(
			entry.timestamp || new Date().toISOString(),
			sessionId,
		);
	}

	rewriteFile(sessionFile: string, entries: FileEntry[]): void {
		const sessionId = pathToSessionId(sessionFile);
		const tx = this.db.transaction(() => {
			// Ensure the session row exists with correct cwd BEFORE deleting entries
			// (insertEntry creates it with empty cwd if missing, so we upsert first)
			const header = entries.find((e): e is SessionHeader => e.type === "session");
			if (header) {
				this.upsertSession(header);
			}

			this.db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);

			for (const entry of entries) {
				if (entry.type === "session") continue;
				this.insertEntry(sessionId, entry as SessionEntry);
			}
		});
		tx();
	}

	createSessionFile(sessionFile: string, header: SessionHeader): void {
		const sessionId = pathToSessionId(sessionFile);
		this.upsertSession(header);
	}

	deleteSessionFile(sessionFile: string): void {
		const sessionId = pathToSessionId(sessionFile);
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM entries_fts WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		});
		tx();
	}

	// ── Directory-level / listing operations ──────────────────────────

	async listSessions(sessionDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		// sessionDir is ignored for SQLite — all sessions are in the same database.
		// Filtering by cwd is handled by the caller.
		// We return all sessions; caller filters.
		return this.listAllSessionsInternal(onProgress);
	}

	async listAllSessions(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		if (typeof sessionDir === "string") {
			// If a specific sessionDir is provided, we filter sessions by cwd directory
			// Since SQLite has all sessions, we filter by those whose cwd starts with or matches the dir
			const dir = normalizePath(sessionDir);
			return this.listAllSessionsInternal(onProgress, dir);
		}
		return this.listAllSessionsInternal(onProgress);
	}

	findMostRecent(sessionDir: string, cwd?: string): string | null {
		let query = "SELECT id FROM sessions ORDER BY modified_at DESC LIMIT 1";
		if (cwd) {
			query = "SELECT id FROM sessions WHERE cwd = ? ORDER BY modified_at DESC LIMIT 1";
			const row = this.db.prepare(query).get(resolvePath(cwd)) as { id: string } | undefined;
			return row?.id ?? null;
		}
		const row = this.db.prepare(query).get() as { id: string } | undefined;
		return row?.id ?? null;
	}

	getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
		// For SQLite store, the session dir is just the db location marker.
		// Not used for actual directory scanning.
		return join(agentDir, "sessions");
	}

	// ── Internal helpers ──────────────────────────────────────────────

	private listAllSessionsInternal(onProgress?: SessionListProgress, filterDir?: string): Promise<SessionInfo[]> {
		let rows: SessionRow[];
		if (filterDir) {
			rows = this.db
				.prepare(
					"SELECT s.*, COUNT(e.id) as message_count FROM sessions s LEFT JOIN entries e ON e.session_id = s.id AND e.type = 'message' WHERE s.cwd LIKE ? GROUP BY s.id ORDER BY s.modified_at DESC",
				)
				.all(`${filterDir}%`) as unknown as SessionRow[];
		} else {
			rows = this.db
				.prepare(
					"SELECT s.*, COUNT(e.id) as message_count FROM sessions s LEFT JOIN entries e ON e.session_id = s.id AND e.type = 'message' GROUP BY s.id ORDER BY s.modified_at DESC",
				)
				.all() as unknown as SessionRow[];
		}

		const sessions: SessionInfo[] = [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const info = this.rowToSessionInfo(row);
			if (info) {
				sessions.push(info);
			}
			onProgress?.(i + 1, rows.length);
		}
		return Promise.resolve(sessions);
	}

	private readSessionById(sessionId: string): SessionHeader | null {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
			| SessionRow
			| undefined;
		if (!row) return null;
		return {
			type: "session",
			version: 3,
			id: row.id,
			timestamp: row.created_at,
			cwd: row.cwd,
			parentSession: row.parent_session || undefined,
		};
	}

	private upsertSession(header: SessionHeader): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO sessions (id, cwd, created_at, modified_at, parent_session)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				header.id,
				header.cwd ?? "",
				header.timestamp || new Date().toISOString(),
				new Date().toISOString(),
				header.parentSession ?? null,
			);
	}

	private insertEntry(sessionId: string, entry: SessionEntry): void {
		// Upsert session if not exists
		const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
		if (!exists) {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO sessions (id, cwd, created_at, modified_at)
           VALUES (?, '', ?, ?)`,
				)
				.run(sessionId, new Date().toISOString(), new Date().toISOString());
		}

		const base = {
			id: entry.id,
			session_id: sessionId,
			parent_id: entry.parentId,
			type: entry.type,
			timestamp: entry.timestamp,
		};

		switch (entry.type) {
			case "message": {
				const msg = entry as SessionMessageEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, role, content_json)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @role, @content_json)`,
					)
					.run({
						...base,
						role: msg.message.role,
						content_json: JSON.stringify(msg.message),
					});
				// Add to FTS
				this.indexMessageForFts(sessionId, entry.id, msg);
				break;
			}
			case "thinking_level_change": {
				const t = entry as ThinkingLevelChangeEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, thinking_level)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @thinking_level)`,
					)
					.run({ ...base, thinking_level: t.thinkingLevel });
				break;
			}
			case "model_change": {
				const m = entry as ModelChangeEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, provider, model_id)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @provider, @model_id)`,
					)
					.run({ ...base, provider: m.provider, model_id: m.modelId });
				break;
			}
			case "compaction": {
				const c = entry as CompactionEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, summary, first_kept_entry_id, tokens_before, content_json)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @summary, @first_kept_entry_id, @tokens_before, @content_json)`,
					)
					.run({
						...base,
						summary: c.summary,
						first_kept_entry_id: c.firstKeptEntryId,
						tokens_before: c.tokensBefore,
						content_json: JSON.stringify(c.details ?? null),
					});
				break;
			}
			case "branch_summary": {
				const b = entry as BranchSummaryEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, from_id, summary, from_hook, content_json)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @from_id, @summary, @from_hook, @content_json)`,
					)
					.run({
						...base,
						from_id: b.fromId,
						summary: b.summary,
						from_hook: b.fromHook ? 1 : 0,
						content_json: JSON.stringify(b.details ?? null),
					});
				break;
			}
			case "custom": {
				const c = entry as CustomEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, custom_type, content_json)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @custom_type, @content_json)`,
					)
					.run({
						...base,
						custom_type: c.customType,
						content_json: JSON.stringify(c.data ?? null),
					});
				break;
			}
			case "label": {
				const l = entry as LabelEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, target_id, label)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @target_id, @label)`,
					)
					.run({
						...base,
						target_id: l.targetId,
						label: l.label ?? null,
					});
				break;
			}
			case "session_info": {
				const s = entry as SessionInfoEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, label)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @label)`,
					)
					.run({
						...base,
						label: s.name ?? null,
					});
				// Also update session name
				if (s.name?.trim()) {
					this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(s.name.trim(), sessionId);
				} else {
					this.db.prepare("UPDATE sessions SET name = NULL WHERE id = ?").run(sessionId);
				}
				break;
			}
			case "custom_message": {
				const cm = entry as CustomMessageEntry;
				this.db
					.prepare(
						`INSERT INTO entries (id, session_id, parent_id, type, timestamp, custom_type, content_json, display)
               VALUES (@id, @session_id, @parent_id, @type, @timestamp, @custom_type, @content_json, @display)`,
					)
					.run({
						...base,
						custom_type: cm.customType,
						content_json: JSON.stringify(cm.content),
						display: cm.display ? 1 : 0,
					});
				this.indexCustomMessageForFts(sessionId, entry.id, cm);
				break;
			}
		}
	}

	private indexMessageForFts(sessionId: string, entryId: string, entry: SessionMessageEntry): void {
		const message = entry.message;
		let text = "";
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			const content = message.content;
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				text = content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join(" ");
			}
		}
		if (text) {
			this.db
				.prepare("INSERT INTO entries_fts (rowid, session_id, entry_id, text_content) VALUES (?, ?, ?, ?)")
				.run(this.nextFtsRowId(), sessionId, entryId, text);
		}
	}

	private indexCustomMessageForFts(
		sessionId: string,
		entryId: string,
		entry: CustomMessageEntry,
	): void {
		let text = "";
		if (typeof entry.content === "string") {
			text = entry.content;
		} else if (Array.isArray(entry.content)) {
			text = entry.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ");
		}
		if (text) {
			this.db
				.prepare("INSERT INTO entries_fts (rowid, session_id, entry_id, text_content) VALUES (?, ?, ?, ?)")
				.run(this.nextFtsRowId(), sessionId, entryId, text);
		}
	}

	private nextFtsRowId(): number {
		// Use a monotonically increasing value based on time
		return Date.now() + Math.floor(Math.random() * 1000);
	}

	private rowToEntry(row: EntryRow): SessionEntry | null {
		const base = {
			id: row.id,
			parentId: row.parent_id,
			timestamp: row.timestamp,
		};

		switch (row.type) {
			case "message": {
				if (!row.content_json) return null;
				try {
					const message = JSON.parse(row.content_json);
					return { ...base, type: "message" as const, message };
				} catch {
					return null;
				}
			}
			case "thinking_level_change":
				return { ...base, type: "thinking_level_change" as const, thinkingLevel: row.thinking_level ?? "off" };
			case "model_change":
				return {
					...base,
					type: "model_change" as const,
					provider: row.provider ?? "",
					modelId: row.model_id ?? "",
				};
			case "compaction": {
				const entry: CompactionEntry = {
					...base,
					type: "compaction",
					summary: row.summary ?? "",
					firstKeptEntryId: row.first_kept_entry_id ?? "",
					tokensBefore: row.tokens_before ?? 0,
				};
				if (row.content_json) {
					try {
						entry.details = JSON.parse(row.content_json);
					} catch {
						// ignore
					}
				}
				return entry;
			}
			case "branch_summary": {
				const entry: BranchSummaryEntry = {
					...base,
					type: "branch_summary",
					fromId: row.from_id ?? "",
					summary: row.summary ?? "",
				};
				if (row.from_hook) entry.fromHook = true;
				if (row.content_json) {
					try {
						entry.details = JSON.parse(row.content_json);
					} catch {
						// ignore
					}
				}
				return entry;
			}
			case "custom":
				return {
					...base,
					type: "custom" as const,
					customType: row.custom_type ?? "",
					data: row.content_json ? tryParseJson(row.content_json) : undefined,
				};
			case "label":
				return {
					...base,
					type: "label" as const,
					targetId: row.target_id ?? "",
					label: row.label ?? undefined,
				};
			case "session_info":
				return {
					...base,
					type: "session_info" as const,
					name: row.label ?? undefined,
				};
			case "custom_message": {
				const rawContent: string | unknown[] = row.content_json ? tryParseContent(row.content_json) : "";
				const entry: CustomMessageEntry = {
					...base,
					type: "custom_message",
					customType: row.custom_type ?? "",
					content: rawContent as string | (import("@piclaw/ai").TextContent | import("@piclaw/ai").ImageContent)[],
					display: row.display === 1,
				};
				return entry;
			}
			default:
				return null;
		}
	}

	private rowToSessionInfo(row: SessionRow): SessionInfo | null {
		return {
			path: row.id, // session id acts as "path" identifier
			id: row.id,
			cwd: row.cwd,
			name: row.name || undefined,
			parentSessionPath: row.parent_session || undefined,
			created: new Date(row.created_at),
			modified: new Date(row.modified_at),
			messageCount: row.message_count ?? 0,
			firstMessage: this.getFirstMessage(row.id),
			allMessagesText: "",
		};
	}

	private getFirstMessage(sessionId: string): string {
		const row = this.db
			.prepare(
				`SELECT content_json FROM entries
         WHERE session_id = ? AND type = 'message'
         ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
			)
			.get(sessionId) as { content_json: string } | undefined;
		if (!row || !row.content_json) return "(no messages)";
		try {
			const msg = JSON.parse(row.content_json);
			if (msg.role !== "user") return "(no messages)";
			const content = msg.content;
			if (typeof content === "string") return content || "(no messages)";
			if (Array.isArray(content)) {
				const text = content
					.filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
					.map((b: { text: string }) => b.text)
					.join(" ");
				return text || "(no messages)";
			}
			return "(no messages)";
		} catch {
			return "(no messages)";
		}
	}
}

// ============================================================================
// Internal types & helpers
// ============================================================================

interface SessionRow {
	id: string;
	cwd: string;
	created_at: string;
	modified_at: string;
	parent_session: string | null;
	name: string | null;
	message_count?: number;
}

interface EntryRow {
	id: string;
	session_id: string;
	parent_id: string | null;
	type: string;
	timestamp: string;
	role: string | null;
	content_json: string | null;
	custom_type: string | null;
	target_id: string | null;
	label: string | null;
	provider: string | null;
	model_id: string | null;
	thinking_level: string | null;
	summary: string | null;
	first_kept_entry_id: string | null;
	tokens_before: number | null;
	from_id: string | null;
	from_hook: number | null;
	display: number | null;
}

/**
 * Convert a session file id/path to a session id.
 * For the SqliteStore, the "sessionFile" is just the session id,
 * since there's no filesystem path involved.
 *
 * Session file format: <timestamp>_<sessionId>.jsonl
 * e.g. 2026-07-01T01-47-04-461Z_019f1b5b-bb8d-7f4e-8fdd-b31e932ed341.jsonl
 */
function pathToSessionId(sessionFile: string): string {
	// If it's already a clean session id (alphanumeric + dots/hyphens/underscores), use it directly
	if (/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(sessionFile)) {
		return sessionFile;
	}
	// If it matches uuid v7 pattern, use it directly
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionFile)) {
		return sessionFile;
	}
	// Extract basename and remove .jsonl extension
	const basename = sessionFile.replace(/.*[\/\\]/, "").replace(/\.jsonl$/i, "");
	// Session file format: <timestamp>_<sessionId>
	// The timestamp ends with 'Z' (ISO 8601), so split on '_' after the timestamp
	// Find the underscore that separates the timestamp from the session id
	const underscoreIdx = basename.indexOf("_");
	if (underscoreIdx > 0) {
		const afterUnderscore = basename.slice(underscoreIdx + 1);
		// Validate it looks like a session id
		if (/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(afterUnderscore)) {
			return afterUnderscore;
		}
	}
	// Fallback: return the basename as-is
	return basename;
}

function tryParseJson(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return str;
	}
}

/**
 * Parse content JSON from a custom_message entry.
 * Returns string or array depending on what was stored.
 */
function tryParseContent(str: string): string | unknown[] {
	try {
		const parsed = JSON.parse(str);
		if (typeof parsed === "string" || Array.isArray(parsed)) {
			return parsed;
		}
		return str;
	} catch {
		return str;
	}
}
