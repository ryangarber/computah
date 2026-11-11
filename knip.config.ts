import type { KnipConfig } from "knip";

export default {
	tags: ["-lintignore"],
	// Found on disk and handed to the browser driver by path, never imported.
	ignoreDependencies: ["playwright-core"],
} satisfies KnipConfig;
