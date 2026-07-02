import {
  createAgentSession,
  SessionManager,
  createBashToolDefinition,
} from "@piclaw/coding-agent";
import { isSafeCommand } from "./plan-bash-guard";
import { PLAN_PROMPT_SUFFIX, PLAN_MODE_MARKER } from "./mode-prompts";
import type { AgentSessionLike, ModelLike } from "./pi-types";

// ============================================================================
// Types
// ============================================================================

export type AgentMode = "plan" | "act";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "bash-readonly"];
const CODING_TOOL_SET = new Set(CODING_TOOL_NAMES);

// Plan mode: read-only investigation only. No edit/write, and `bash` is
// replaced by a spawnHook-guarded variant (see startRpcSession) that rejects
// state-changing commands via isSafeCommand.
const ACT_BUILTIN = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const PLAN_BUILTIN = ["read", "bash-readonly", "grep", "find", "ls"];

// Extension/package tools that are known to be read-only and thus safe in
// plan mode. Empty by default — extension tools are NOT auto-included in
// plan mode, which is what previously made the old "plan" preset leak.
const PLAN_READONLY_EXTENSION_ALLOWLIST = new Set<string>([]);

const MODE_CUSTOM_TYPE = "pi-web-mode";

/** Build the active tool list for a mode. Extension tools default-on in act,
 *  and fully disabled in plan unless on the read-only allowlist. */
function toolsForMode(session: AgentSessionLike, mode: AgentMode): string[] {
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !CODING_TOOL_SET.has(name));
  if (mode === "plan") {
    const safe = extensionToolNames.filter((n) => PLAN_READONLY_EXTENSION_ALLOWLIST.has(n));
    return [...new Set([...PLAN_BUILTIN, ...safe])];
  }
  return [...new Set([...ACT_BUILTIN, ...extensionToolNames])];
}

/** Strip any previously-injected plan suffix from a (possibly rebuilt) prompt. */
function stripPlanSuffix(prompt: string): string {
  const idx = prompt.indexOf(PLAN_MODE_MARKER);
  if (idx === -1) return prompt;
  return prompt.slice(0, idx).replace(/\n+$/, "");
}

/** Insert the plan mode header before "Available tools:", with consistent formatting. */
function injectPlanSuffix(base: string): string {
  const insertPos = base.indexOf("\nAvailable tools:");
  if (insertPos !== -1) {
    return (
      base.slice(0, insertPos + 1) +
      PLAN_PROMPT_SUFFIX.trim() +
      "\n\n" +
      base.slice(insertPos + 1)
    );
  }
  // Fallback: append with consistent separator
  return base + "\n\n" + PLAN_PROMPT_SUFFIX.trim();
}

/** Scan a session file's custom entries for the last `pi-web-mode` record. */
function readModeFromFile(sessionFile: string | undefined): AgentMode | null {
  if (!sessionFile) return null;
  try {
    const entries = SessionManager.open(sessionFile).getEntries();
    let last: AgentMode | null = null;
    for (const e of entries) {
      const c = e as { customType?: string; data?: { mode?: string } };
      if (c.customType === MODE_CUSTOM_TYPE && (c.data?.mode === "plan" || c.data?.mode === "act")) {
        last = c.data!.mode as AgentMode;
      }
    }
    return last;
  } catch {
    return null;
  }
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private _mode: AgentMode;
  /** Shared with the custom bash tool's spawnHook so it can read the live mode. */
  readonly modeRef: { mode: AgentMode };

  constructor(public readonly inner: AgentSessionLike, modeRef: { mode: AgentMode }) {
    this.modeRef = modeRef;
    this._mode = modeRef.mode;
  }

  get mode(): AgentMode {
    return this._mode;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      // pi rebuilds the system prompt after compaction, which strips our
      // injected plan suffix. Re-inject it if we are still in plan mode.
      if (
        (event.type === "compaction_end" || event.type === "auto_compaction_end") &&
        this._mode === "plan" &&
        !(event as { aborted?: boolean }).aborted
      ) {
        this.applySystemPromptForMode("plan");
      }
      for (const l of this.listeners) l(event);
    });
    this.resetIdleTimer();
  }

  /** Rebuild system prompt + inject/strip plan header for the current mode. */
  private applySystemPromptForMode(mode: AgentMode): void {
    this.inner.setActiveToolsByName(toolsForMode(this.inner, mode));
    const base = stripPlanSuffix(this.inner.agent.state.systemPrompt ?? "");
    this.inner.agent.state.systemPrompt =
      mode === "plan" ? injectPlanSuffix(base) : base;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /** Lightweight state peek — does NOT reset idle timer.
   *  Used by stall-detection polling so it doesn't prevent session cleanup.
   *  Returns the same fields as get_state (minus messageCount/pendingMessageCount,
   *  which are always 0) so callers don't lose data vs. send({type:"get_state"}). */
  peekState(): {
    isStreaming: boolean;
    isCompacting: boolean;
    autoCompactionEnabled: boolean;
    autoRetryEnabled: boolean;
    model: ModelLike | undefined;
    contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    systemPrompt: string;
    thinkingLevel: string;
    mode: AgentMode;
  } {
    const cu = this.inner.getContextUsage();
    return {
      isStreaming: this.inner.isStreaming,
      isCompacting: this.inner.isCompacting,
      autoCompactionEnabled: this.inner.autoCompactionEnabled,
      autoRetryEnabled: this.inner.autoRetryEnabled,
      model: this.inner.model,
      contextUsage: cu ? { percent: cu.percent, contextWindow: cu.contextWindow, tokens: cu.tokens } : null,
      systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
      thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
      mode: this._mode,
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.inner.prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined).catch(() => {});
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          mode: this._mode,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const registry = this.inner.modelRegistry;
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        return result;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "set_mode": {
        const mode = command.mode as AgentMode;
        if (mode !== "plan" && mode !== "act") throw new Error(`Invalid mode: ${mode}`);
        this._mode = mode;
        this.modeRef.mode = mode;
        this.applySystemPromptForMode(mode);
        try {
          this.inner.sessionManager.appendCustomEntry(MODE_CUSTOM_TYPE, { mode });
        } catch {
          // non-persisted session — nothing to write
        }
        return { mode };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/** Debug introspection: registry size + per-session listener counts.
 *  Used to diagnose SSE listener leaks. */


/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass `mode` to pre-configure plan/act mode (default: act).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  mode: AgentMode = "act"
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const { SessionManager, getAgentDir } = await import("@piclaw/coding-agent");
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    // Resolve the initial mode: explicit arg > last persisted mode in file > act.
    const persistedMode = readModeFromFile(sessionFile);
    const initialMode: AgentMode = mode ?? persistedMode ?? "act";

    // Shared mode holder read by the custom bash spawnHook. The hook is a
    // no-op in act mode and rejects state-changing commands in plan mode.
    const modeRef = { mode: initialMode } as { mode: AgentMode };

    // Register a custom bash tool with a DIFFERENT name for plan mode.
    // `bash-readonly` has a read-only description and spawnHook guard.
    // The builtin `bash` (no guard) stays in the registry for act mode.
    const readonlyBash = {
      ...createBashToolDefinition(cwd, {
        spawnHook: (ctx) => {
          if (modeRef.mode === "plan" && !isSafeCommand(ctx.command)) {
            throw new Error(
              `Plan mode blocked command (not read-only): ${ctx.command}`
            );
          }
          return ctx;
        },
      }),
      name: "bash-readonly",
      label: "bash-readonly",
      promptSnippet:
        "Execute read-only bash commands. Blocked: rm, mv, > file write, >>, npm install, git push, sudo, and other state-changing operations. Allowed: cat, head, tail, grep, find, ls, pwd, echo, sort, diff, file, which, ps, date, curl, jq, git status/log/diff, and similar read-only queries.",
    };

    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      // readonlyBash has a different name ("bash-readonly") so both it and
      // the builtin "bash" coexist in the registry. Plan mode activates
      // bash-readonly; act mode activates builtin bash.
      customTools: [readonlyBash] as unknown as NonNullable<
        NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"]
      >,
    });

    // Apply the initial mode's tool set + prompt suffix. For act mode this is
    // the default builtins + extensions; for plan mode it is the read-only set
    // (which uses bash-readonly instead of bash) with the plan header injected.
    inner.setActiveToolsByName(toolsForMode(inner, initialMode));
    if (initialMode === "plan") {
      const base = stripPlanSuffix(inner.agent.state.systemPrompt ?? "");
      inner.agent.state.systemPrompt = injectPlanSuffix(base);
    }

    const wrapper = new AgentSessionWrapper(inner, modeRef);
    wrapper.start();

    const realSessionId = inner.sessionId as string;

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
