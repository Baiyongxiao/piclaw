"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useReducer } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode, AgentMode } from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { MESSAGE_PAGE_SIZE } from "@/lib/constants";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  totalMessageCount?: number;
  oldestLoadedEntryId?: string | null;
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  setMode?: (mode: AgentMode) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [mode, setMode] = useState<AgentMode>("act");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);

  // Pagination state for message history
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const loadingMoreRef = useRef(false);
  /** Set before prepending messages to prevent auto-scroll from firing on the next render */
  const pendingPrependRef = useRef(false);
  /** Height of the scroll container before prepending, used to restore scroll position */
  const prevScrollHeightRef = useRef(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const mountedRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const setModeState = opts.setMode ?? setMode;
  const prevModeRef = useRef<AgentMode>(mode);

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = (() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  })();

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams();
      if (includeState) params.set("includeState", "1");
      // includeState fetches live agent state from the RPC process
      const qs = params.toString();
      const url = qs
        ? `/api/sessions/${encodeURIComponent(sid)}?${qs}`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setEntryIds([]);
          setTotalMessageCount(0);
          setHasMoreMessages(false);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; mode?: AgentMode; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
      setData(d);
      setActiveLeafId(d.leafId);
      // Replace messages on normal/initial load (but not on background SSE refresh)
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      // Track pagination metadata
      if (d.totalMessageCount !== undefined) {
        setTotalMessageCount(d.totalMessageCount);
        setHasMoreMessages(d.totalMessageCount > d.context.messages.length);
      }
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      if (d.agentState?.state?.mode) setModeState(d.agentState.state.mode);
      return d.agentState ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setModeState]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const url = leafId
        ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
        : `/api/sessions/${encodeURIComponent(sid)}/context`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] }; totalMessageCount?: number };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      if (d.totalMessageCount !== undefined) {
        setTotalMessageCount(d.totalMessageCount);
        setHasMoreMessages(d.totalMessageCount > d.context.messages.length);
      }
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  /** Load older messages (cursor-based pagination). Prepends to existing messages. */
  const handleLoadMore = useCallback(async (beforeEntryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid || loadingMoreRef.current || !hasMoreMessages) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const url = `/api/sessions/${encodeURIComponent(sid)}/messages?beforeEntryId=${encodeURIComponent(beforeEntryId)}&limit=${MESSAGE_PAGE_SIZE}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { messages: AgentMessage[]; entryIds: string[]; hasMore: boolean; nextCursor: string | null };
      if (!mountedRef.current) return;
      if (d.messages.length > 0) {
        // Save scroll height before prepend so we can restore position after re-render
        const container = scrollContainerRef.current;
        if (container) prevScrollHeightRef.current = container.scrollHeight;
        // Set flag BEFORE setMessages so the scroll effect in the next render
        // can detect this was a prepend and skip auto-scroll.
        pendingPrependRef.current = true;
        // Prepend older messages
        setMessages((prev) => [...d.messages, ...prev]);
        setEntryIds((prev) => [...d.entryIds, ...prev]);
      }
      setHasMoreMessages(d.hasMore);
    } catch (e) {
      console.error("Failed to load more messages:", e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMoreMessages]);

  /** Reload session with full message list (used after compaction / abort). */
  const loadSessionFull = useCallback(async (sid: string, showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?full=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (!mountedRef.current) return;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setTotalMessageCount(d.totalMessageCount ?? d.context.messages.length);
      setHasMoreMessages(false);
      setCurrentModelOverride(null);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const connectEvents = useCallback((sid: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (eventSourceRef.current === es && agentRunningRef.current) {
        es.close();
        eventSourceRef.current = null;
        setTimeout(async () => {
          // Guard: don't reconnect if component unmounted or agent stopped
          if (!mountedRef.current || !agentRunningRef.current) return;
          // Check if agent is still streaming before reconnecting
          try {
            const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const d = await res.json() as { running?: boolean; state?: { isStreaming?: boolean } };
            if (!mountedRef.current || !agentRunningRef.current) return;
            if (d?.state?.isStreaming) {
              connectEvents(sid);
            } else {
              // Agent stopped while disconnected — clean up client state
              setAgentRunning(false);
              setAgentPhase(null);
              loadSession(sid);
            }
          } catch {
            // Network error — retry connection
            if (mountedRef.current && agentRunningRef.current) connectEvents(sid);
          }
        }, 1500);
      }
    };
  }, [loadSession]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          // Don't call loadSession() — the streaming infrastructure already appended
          // the assistant message to `messages` via message_end. Just refresh metadata.
          const sid = sessionIdRef.current;
          fetch(`/api/agent/${encodeURIComponent(sid)}`)
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json() as Promise<{ state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; isCompacting?: boolean; mode?: AgentMode; thinkingLevel?: string } }>;
            })
            .then((d) => {
              if (!mountedRef.current) return;
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.mode) setModeState(d.state.mode);
              if (d.state?.thinkingLevel) setThinkingLevel(d.state.thinkingLevel as ThinkingLevelOption);
            })
            .catch(() => {});
          // Also update data (tree, leafId) without overwriting messages
          fetch(`/api/sessions/${encodeURIComponent(sid)}`)
            .then((r) => {
              if (!r.ok) return null;
              return r.json() as Promise<SessionData & { totalMessageCount?: number; oldestLoadedEntryId?: string | null }>;
            })
            .then((d) => {
              if (!d || !mountedRef.current) return;
              // Update data (tree, leafId) without overwriting messages
              setData((prev) => prev ? { ...prev, tree: d.tree, leafId: d.leafId, filePath: d.filePath, sessionId: d.sessionId, info: (d as unknown as Record<string, unknown>).info } : prev);
              if (d.totalMessageCount !== undefined) {
                setTotalMessageCount(d.totalMessageCount);
              }
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          // Compaction changes the message structure — reload full context
          if (sessionIdRef.current) loadSessionFull(sessionIdRef.current);
        }
        break;
    }
  }, [loadSessionFull, onAgentEnd, setModeState]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunning) return;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message,
            mode,
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        connectEvents(realId);
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
        });
      } else if (session) {
        connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, mode, thinkingLevel, session, agentRunning, connectEvents, onSessionCreated]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Close SSE immediately to stop UI streaming
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setAgentRunning(false);
    setAgentPhase(null);
    // Send abort with a timeout so it doesn't block the UI
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      await fetch(`/api/agent/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch {
      // ignore abort/timeout — client already stopped
    }
    // Reload session to get final state after abort
    if (mountedRef.current) {
      try { loadSessionFull(sid); } catch { /* ignore */ }
    }
  }, [loadSessionFull]);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSessionFull(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSessionFull]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleModeChange = useCallback(async (nextMode: AgentMode) => {
    const prev = prevModeRef.current;
    setModeState(nextMode);
    prevModeRef.current = nextMode;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_mode", mode: nextMode });
    } catch (e) {
      console.error("Failed to set mode:", e);
      setModeState(prev);
      prevModeRef.current = prev; // rollback ref too
    }
  }, [setModeState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session on mount
  useEffect(() => {
    mountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          if (agentState.state?.isStreaming) {
            setAgentRunning(true);
            setAgentPhase({ kind: "waiting_model" });
            connectEvents(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.mode) setModeState(agentState.state.mode);
        }
      });
    }
    return () => {
      mountedRef.current = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (messages.length > 0) {
      // If messages were just prepended (pagination), skip all auto-scroll
      if (pendingPrependRef.current) {
        pendingPrependRef.current = false;
        return;
      }
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && completionScrollAllowedRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, scrollToBottom, scrollUserMsgToTop]);

  // After prepending older messages, restore scroll position so the viewport
  // doesn't jump to the top of the newly inserted content.
  useLayoutEffect(() => {
    if (pendingPrependRef.current && prevScrollHeightRef.current > 0) {
      const container = scrollContainerRef.current;
      if (container) {
        const delta = container.scrollHeight - prevScrollHeightRef.current;
        if (delta > 0) {
          container.scrollTop = delta;
        }
      }
      prevScrollHeightRef.current = 0;
    }
  });

  // Load model list
  useEffect(() => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const controller = new AbortController();
    fetch(modelsUrl, { signal: controller.signal }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d: ModelsResponse) => {
      setModelNames(d.models);
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      const nextModelList = d.modelList ?? [];
      setModelList(nextModelList);
      if (isNew) {
        const match = d.defaultModel
          ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
          : undefined;
        const displayModel = match ?? nextModelList[0];
        setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      }
    }).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [isNew, modelsRefreshKey, newSessionCwd, session?.cwd]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  // Periodic stall detection: poll agent state while streaming.
  // If the SSE event queue is bottlenecked by large message_update payloads
  // (e.g., when generating a large file), the agent_end event may take
  // many seconds to arrive. This check prevents the UI from appearing stuck.
  //
  // Safety: polling is capped at 15 minutes total per streaming session to
  // prevent indefinite server-side session lifetime extension.
  const STALL_POLL_MAX_DURATION_MS = 15 * 60 * 1000;
  const stallCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartTimeRef = useRef<number>(0);
  useEffect(() => {
    if (agentRunning) {
      pollStartTimeRef.current = Date.now();
      stallCheckTimerRef.current = setInterval(() => {
        const sid = sessionIdRef.current;
        if (!sid || !agentRunningRef.current) return;
        // Stop polling if we've exceeded the safety cap
        if (Date.now() - pollStartTimeRef.current > STALL_POLL_MAX_DURATION_MS) {
          if (stallCheckTimerRef.current) {
            clearInterval(stallCheckTimerRef.current);
            stallCheckTimerRef.current = null;
          }
          return;
        }
        fetch(`/api/agent/${encodeURIComponent(sid)}`)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json() as Promise<{ state?: { isStreaming?: boolean } }>;
          })
          .then((d) => {
            if (!d?.state?.isStreaming && agentRunningRef.current) {
              // Agent stopped but we missed the agent_end event — clean up
              setAgentRunning(false);
              setAgentPhase(null);
              loadSessionFull(sid);
            }
          })
          .catch(() => {});
      }, 10000);
      return () => {
        if (stallCheckTimerRef.current) {
          clearInterval(stallCheckTimerRef.current);
          stallCheckTimerRef.current = null;
        }
      };
    } else {
      if (stallCheckTimerRef.current) {
        clearInterval(stallCheckTimerRef.current);
        stallCheckTimerRef.current = null;
      }
    }
  }, [agentRunning, loadSession]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, mode, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    // Pagination state
    totalMessageCount, loadingMore, hasMoreMessages,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleModeChange, handleThinkingLevelChange, handleLoadMore,
    setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}
