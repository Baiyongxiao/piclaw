/**
 * Plan mode system prompt.
 *
 * Plan mode now uses `buildPlanSystemPrompt` from @piclaw/coding-agent
 * (in system-prompt.ts) which generates a completely independent agent
 * identity for plan mode — following OpenCode's approach of separate
 * prompts per mode rather than suffix injection on the act prompt.
 *
 * The old suffix-injection approach has been removed.
 * See web/lib/rpc-manager.ts for the deny-list tool strategy.
 */
