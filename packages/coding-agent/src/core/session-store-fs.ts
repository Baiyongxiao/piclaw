import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";
import type {
	SessionStore,
	SessionHeader,
	SessionEntry,
	FileEntry,
	SessionInfo,
	SessionListProgress,
	SessionMessageEntry,
} from "./session-store.ts";
import type { AgentMessage } from "@piclaw/agent-core";
import type { Message, TextContent } from "@piclaw/ai";

// ============================================================================
// File parsing helpers
// ============================================================================

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

// ============================================================================
// FileSystemStore — persists sessions as .jsonl files (original default)
// ============================================================================

export class FileSystemStore implements SessionStore {
	loadEntries(sessionFile: string): FileEntry[] {
		const resolvedFilePath = normalizePath(sessionFile);
		if (!existsSync(resolvedFilePath)) return [];

		const entries: FileEntry[] = [];
		const fd = openSync(resolvedFilePath, "r");
		try {
			const decoder = new StringDecoder("utf8");
			const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
			let pending = "";

			while (true) {
				const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;

				pending += decoder.write(buffer.subarray(0, bytesRead));
				let lineStart = 0;
				let newlineIndex = pending.indexOf("\n", lineStart);
				while (newlineIndex !== -1) {
					const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
					if (entry) entries.push(entry);
					lineStart = newlineIndex + 1;
					newlineIndex = pending.indexOf("\n", lineStart);
				}
				pending = pending.slice(lineStart);
			}

			pending += decoder.end();
			const finalEntry = parseSessionEntryLine(pending);
			if (finalEntry) entries.push(finalEntry);
		} finally {
			closeSync(fd);
		}

		// Validate session header
		if (entries.length === 0) return entries;
		const header = entries[0];
		if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
			return [];
		}

		return entries;
	}

	readHeader(sessionFile: string): SessionHeader | null {
		try {
			const fd = openSync(sessionFile, "r");
			const buffer = Buffer.alloc(512);
			const bytesRead = readSync(fd, buffer, 0, 512, 0);
			closeSync(fd);
			const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
			if (!firstLine) return null;
			const header = JSON.parse(firstLine) as Record<string, unknown>;
			if (header.type !== "session" || typeof header.id !== "string") {
				return null;
			}
			return header as unknown as SessionHeader;
		} catch {
			return null;
		}
	}

	sessionFileExists(sessionFile: string): boolean {
		return existsSync(normalizePath(sessionFile));
	}

	appendToFile(sessionFile: string, entry: SessionEntry): void {
		appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	}

	rewriteFile(sessionFile: string, entries: FileEntry[]): void {
		const fd = openSync(sessionFile, "w");
		try {
			for (const entry of entries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	createSessionFile(sessionFile: string, header: SessionHeader): void {
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}

	deleteSessionFile(sessionFile: string): void {
		const { unlinkSync } = require("fs");
		try {
			unlinkSync(normalizePath(sessionFile));
		} catch {
			// File may not exist
		}
	}

	// ── Directory-level operations ──────────────────────────────────────

	async listSessions(sessionDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = normalizePath(sessionDir);
		const sessions: SessionInfo[] = [];
		if (!existsSync(dir)) return sessions;

		try {
			const dirEntries = await readdir(dir);
			const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
			const results = await buildSessionInfosWithConcurrency(files, () => {
				// progress is handled by the caller or internally
			});
			for (const info of results) {
				if (info) sessions.push(info);
			}
		} catch {
			// Return empty list on error
		}
		return sessions;
	}

	async listAllSessions(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDir === "string" ? normalizePath(sessionDir) : undefined;
		const progress = onProgress;

		if (customSessionDir) {
			const sessions = await this.listSessions(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) return [];
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// Count total files for progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			let loaded = 0;
			const allFiles = dirFiles.flat();
			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			const sessions: SessionInfo[] = [];
			for (const info of results) {
				if (info) sessions.push(info);
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}

	findMostRecent(sessionDir: string, cwd?: string): string | null {
		const resolvedSessionDir = normalizePath(sessionDir);
		const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
		try {
			const files = readdirSync(resolvedSessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => join(resolvedSessionDir, f))
				.map((path) => ({ path, header: this.readHeader(path) }))
				.filter(
					(file): file is { path: string; header: SessionHeader } =>
						file.header !== null &&
						(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
				)
				.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			return null;
		}
	}

	getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const dir = join(resolvedAgentDir, "sessions", safePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}
}

// ============================================================================
// Internal helpers (moved from session-manager.ts)
// ============================================================================

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return (content as unknown[])
		.filter((block): block is TextContent => (block as TextContent).type === "text")
		.map((block) => (block as TextContent).text)
		.join(" ");
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;
	let loaded = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		const task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				loaded++;
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}
