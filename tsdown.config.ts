import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/schema.ts",
		"src/browser.ts",
		"src/terminal.ts",
		"src/computer.ts",
	],
	format: "esm",
	dts: true,
	treeshake: true,
	target: "es2024",
	fixedExtension: true,
	platform: "node",
});
