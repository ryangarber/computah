import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
		typecheck: {
			enabled: true,
		},
		coverage: {
			provider: "v8",
		},
	},
});
