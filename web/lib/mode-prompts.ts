/**
 * System-prompt injected while in Plan mode.
 *
 * Injected on every turn after the base system prompt is rebuilt.
 * Stripped on switch back to Act mode.
 */
export const PLAN_PROMPT_SUFFIX = `[PLAN MODE ACTIVE]
You are in PLAN MODE. Rules:
1. DO NOT use tools that modify files (edit, write) — they are not available.
2. DO NOT run state-changing bash (npm install, git commit, sed -i, etc.).
3. ONLY use read-only tools: read, grep, find, ls, and read-only bash commands.
4. When asked for work, output a concrete numbered plan under "## Plan".
5. Do NOT execute the plan yourself. Wait for the user to switch to Act mode.
If you break these rules, the tool call will be rejected.`;

/** Marker used to detect/strip the plan suffix from a rebuilt prompt. */
export const PLAN_MODE_MARKER = "[PLAN MODE ACTIVE]";
