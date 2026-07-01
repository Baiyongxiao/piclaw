import type { AgentMessage } from "@piclaw/agent-core";
import type { ImageContent, TextContent } from "@piclaw/ai";

// ============================================================================
// Types — mirrored from session-manager.ts for import convenience
// ============================================================================

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

// ============================================================================
// SessionStore interface
// ============================================================================

/**
 * Abstract storage backend for session persistence.
 *
 * Implementations:
 * - `SqliteStore` — stores all sessions in a single SQLite database with FTS5 (default)
 *
 * SessionManager delegates all I/O operations to this interface,
 * keeping only in-memory state management (tree index, leaf pointer, labels).
 */
export interface SessionStore {
	// ── Instance-level operations ──────────────────────────────────────

	/** Load all entries from a session identified by its file path / id. */
	loadEntries(sessionFile: string): FileEntry[];

	/** Read just the header of a session. */
	readHeader(sessionFile: string): SessionHeader | null;

	/** Check if a session file exists on disk / in database. */
	sessionFileExists(sessionFile: string): boolean;

	/** Append a single entry to the session. */
	appendToFile(sessionFile: string, entry: SessionEntry): void;

	/** Rewrite the entire session file with the given entries (full replace). */
	rewriteFile(sessionFile: string, entries: FileEntry[]): void;

	/** Create a new session file with a header. */
	createSessionFile(sessionFile: string, header: SessionHeader): void;

	/** Delete a session file. */
	deleteSessionFile(sessionFile: string): void;

	// ── Directory-level / listing operations ──────────────────────────

	/** List all sessions in a specific session directory. */
	listSessions(sessionDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;

	/** List all sessions across all directories (or in a specific custom dir). */
	listAllSessions(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;

	/** Find the most recent session file in a directory, optionally filtering by cwd. */
	findMostRecent(sessionDir: string, cwd?: string): string | null;

	/** Get the default session directory for a given cwd. */
	getDefaultSessionDir(cwd: string, agentDir?: string): string;
}
