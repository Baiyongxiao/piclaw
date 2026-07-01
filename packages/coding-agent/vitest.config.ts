import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@piclaw\/ai$/, replacement: aiSrcIndex },
			{ find: /^@piclaw\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@piclaw\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@piclaw\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@piclaw\/tui$/, replacement: tuiSrcIndex },
		],
	},
});
