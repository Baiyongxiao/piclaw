/**
 * Plan mode bash command guard.
 *
 * Borrowed from pi's `examples/extensions/plan-mode/utils.ts`.
 * In Plan mode the bash tool's spawnHook consults `isSafeCommand`:
 * a command is allowed only if it is not destructive AND matches a
 * known read-only pattern. Anything else is rejected before spawn.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>|\s*&[012-]|\s*\/dev\/null\b)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|branch\s+--delete|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /find.*-delete/,
  /find.*-exec\s+rm/,
  /curl\s+-[oO]/,   // block curl -o/-O (write file)
  /awk\s+-i/,        // block awk -i inplace (modify in place)
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
  // Shell control flow keywords — harmless on their own; destructive commands
  // inside loops/conditionals are caught by DESTRUCTIVE_PATTERNS per-segment.
  /^\s*for\b/,
  /^\s*while\b/,
  /^\s*until\b/,
  /^\s*do\b/,
  /^\s*done\b/,
  /^\s*if\b/,
  /^\s*then\b/,
  /^\s*elif\b/,
  /^\s*else\b/,
  /^\s*fi\b/,
  /^\s*case\b/,
  /^\s*esac\b/,
  /^\s*in\b/,
  /^\s*select\b/,
  /^\s*time\b/,
  /^\s*\{/,
  /^\s*\}/,
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+-C\s+\S+\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*git\s+--version/i,
  /^\s*command\s+-v\b/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  /^\s*tvly\b/,
];

export function isSafeCommand(command: string): boolean {
  // Split on command separators and check each segment independently.
  // This ensures `cmd1 && cmd2` evaluates both parts, not just the first.
  const segments = command.split(/\s*(?:&&|\|\||\||;)\s*/);
  return segments.every((seg) => {
    const trimmed = seg.trim();
    if (!trimmed) return true;
    const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed));
    const isSafe = SAFE_PATTERNS.some((p) => p.test(trimmed));
    return !isDestructive && isSafe;
  });
}
