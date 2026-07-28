import {
  createAgentSession,
  SessionManager,
} from "@piclaw/coding-agent";
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

// ============================================================================
// Tool strategy: Deny-list (OpenCode style)
//
// Plan mode: all tools available EXCEPT edit/write.
// Bash is kept — the plan prompt constrains the LLM to read-only usage.
// Act mode:  all tools are available.
// ============================================================================

/** Tool names that modify files — excluded in plan mode. Bash is kept; the plan prompt instructs the LLM to only use read-only commands. */
const DESTRUCTIVE_TOOL_NAMES = new Set(["edit", "write"]);

/** Build the active tool list for a mode. */
function toolsForMode(session: AgentSessionLike, mode: AgentMode): string[] {
  const allToolNames = session.getAllTools().map((t) => t.name);
  if (mode === "plan") {
    // Plan mode: exclude destructive tools, everything else (including
    // extension tools like Tavily, MCP, etc.) is available.
    return allToolNames.filter((name) => !DESTRUCTIVE_TOOL_NAMES.has(name));
  }
  // Act mode: all tools available.
  return allToolNames;
}

const MODE_CUSTOM_TYPE = "pi-web-mode";

// ============================================================================
// Plan mode system prompt
//
// Uses `buildPlanSystemPrompt` from @piclaw/coding-agent which generates
// a completely different agent identity for plan mode (planning/research
// assistant, never mentions editing/writing). This follows OpenCode's
// approach of separate prompts per mode rather than suffix injection.
// ============================================================================

async function rebuildPlanSystemPrompt(
  session: AgentSessionLike,
  toolNames: string[],
): Promise<void> {
  const { buildPlanSystemPrompt } = await import("@piclaw/coding-agent");
  const opts = session.baseSystemPromptOptions;
  if (!opts) {
    // Fallback: construct minimal options from session state
    const snippets: Record<string, string> = {};
    for (const t of session.getAllTools()) {
      if (toolNames.includes(t.name)) {
        snippets[t.name] = (t.description ?? "").split("\n")[0].slice(0, 120);
      }
    }
    session.setPlanBaseSystemPrompt(buildPlanSystemPrompt({
      cwd: session.sessionManager.getCwd(),
      selectedTools: toolNames,
      toolSnippets: snippets,
    }));
    return;
  }
  session.setPlanBaseSystemPrompt(buildPlanSystemPrompt({
    ...opts,
    selectedTools: toolNames,
  }));
}

// ============================================================================
// AgentSessionWrapper
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private _mode: AgentMode;

  constructor(public readonly inner: AgentSessionLike, initialMode: AgentMode) {
    this._mode = initialMode;
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
      // After compaction, pi rebuilds the system prompt via
      // _rebuildSystemPrompt which uses the act-mode builder.
      // Re-apply the plan prompt if we are still in plan mode.
      if (
        (event.type === "compaction_end" || event.type === "auto_compaction_end") &&
        this._mode === "plan" &&
        !(event as { aborted?: boolean }).aborted
      ) {
        this.applyMode("plan").catch((err) => {
          console.error("[rpc-manager] Failed to re-apply plan mode after compaction:", err);
        });
      }
      for (const l of this.listeners) l(event);
    });
    this.resetIdleTimer();
  }

  /** Apply mode: switch tools + rebuild system prompt. */
  private async applyMode(mode: AgentMode): Promise<void> {
    const toolNames = toolsForMode(this.inner, mode);
    this.inner.setActiveToolsByName(toolNames);
    if (mode === "plan") {
      await rebuildPlanSystemPrompt(this.inner, toolNames);
    }
    // Act mode: setActiveToolsByName already rebuilt with the correct
    // (act) system prompt — nothing extra needed.
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
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
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
        await this.applyMode(mode);
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

// ============================================================================
// Session startup
// ============================================================================

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
    const { getAgentDir } = await import("@piclaw/coding-agent");
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    const persistedMode = readModeFromFile(sessionFile);
    const initialMode: AgentMode = mode ?? persistedMode ?? "act";

    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
    });

    // Apply initial mode: tool set + system prompt.
    const toolNames = toolsForMode(inner, initialMode);
    inner.setActiveToolsByName(toolNames);
    if (initialMode === "plan") {
      await rebuildPlanSystemPrompt(inner, toolNames);
    }

    const wrapper = new AgentSessionWrapper(inner, initialMode);
    wrapper.start();

    const realSessionId = inner.sessionId as string;

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
