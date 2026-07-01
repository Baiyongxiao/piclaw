/**
 * Minimal type declarations for better-sqlite3.
 */
declare module "better-sqlite3" {
	interface BetterSqlite3Database {
		prepare(sql: string): Statement;
		exec(sql: string): this;
		transaction<T extends (...args: never[]) => unknown>(fn: T): T;
		pragma(sql: string, options?: { simple?: boolean }): unknown;
		close(): void;
		readonly memory: boolean;
		readonly readonly: boolean;
		readonly name: string;
		readonly open: boolean;
		readonly inTransaction: boolean;
	}

	interface Statement {
		run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
		get(...params: unknown[]): Record<string, unknown> | undefined;
		all(...params: unknown[]): Record<string, unknown>[];
		raw(): this;
		columns(): { name: string; columns?: boolean }[];
		bind(...params: unknown[]): this;
	}

	interface SqliteOptions {
		readonly?: boolean;
		memory?: boolean;
		timeout?: number;
	}

	interface DatabaseConstructor {
		new (filename: string, options?: SqliteOptions): BetterSqlite3Database;
		(filename: string, options?: SqliteOptions): BetterSqlite3Database;
	}

	declare const Database: DatabaseConstructor;
	export type { BetterSqlite3Database };
	export default Database;
}
