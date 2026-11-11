import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Requirement } from "../core/grammar.ts";
import { type Exec, Paths, whichInShell } from "../core/process.ts";
import type { BrowserInstall } from "./schema.ts";

/** The playwright-core computah installs for itself when none is found. */
export const PLAYWRIGHT_VERSION = "1.65.0";

const list = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

const readJson = (file: string): { version?: string } | null => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

const compare = (a: string, b: string) => {
	const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	}
	return 0;
};

const isBun = () => !!(process.versions as Record<string, string>).bun;

export interface Runtime {
	path: string;
	version?: string;
	/** `option`, `host` (the runtime computah itself runs in) or `system`. */
	source: string;
	/** Extra environment the driver needs to run in it. */
	env?: Record<string, string>;
}

/**
 * The runtime the driver runs in. Node is what Playwright is written for, so
 * it is preferred wherever it can be found; where there is none, the host's
 * own runtime stands in.
 */
export const findRuntime = async ({
	runtime,
	exec,
}: {
	runtime?: string;
	exec?: Exec;
} = {}): Promise<Runtime> => {
	if (runtime) return { path: runtime, source: "option" };
	if (!isBun()) {
		return { path: process.execPath, version: process.version, source: "host" };
	}
	const node =
		Paths.which("node", Paths.common()) ??
		(await whichInShell("node", exec).catch(() => undefined));
	if (node) return { path: node, source: "system" };
	return {
		path: process.execPath,
		version: `bun ${(process.versions as Record<string, string>).bun}`,
		source: "host",
		// A compiled Bun program runs scripts only when told to act as Bun.
		env: { BUN_BE_BUN: "1" },
	};
};

export interface PlaywrightInstall {
	path: string;
	name: string;
	version: string;
	/** `option`, `bundled`, `computah`, `project` or `system`. */
	source: string;
}

const readPackage = (dir: string, source: string): PlaywrightInstall[] => {
	const found: PlaywrightInstall[] = [];
	for (const name of ["playwright-core", "playwright"]) {
		const pkg = readJson(join(dir, name, "package.json"));
		if (!pkg?.version) continue;
		try {
			found.push({
				path: realpathSync(join(dir, name)),
				name,
				version: pkg.version,
				source,
			});
		} catch {}
	}
	return found;
};

/** Where `install()` puts a playwright-core of computah's own. */
export const playwrightHome = (home?: string) =>
	join(Paths.data(home), "playwright", "node_modules");

/**
 * Playwright, in the order it should be trusted: one passed in, the copy
 * computah was installed with, one computah downloaded, the project's own
 * (walking up from the working directory, pnpm's store included), then global
 * installs and npx's cache, newest first.
 */
export const findPlaywright = ({
	playwright,
	cwd = process.cwd(),
	home,
}: {
	playwright?: string;
	cwd?: string;
	home?: string;
} = {}): PlaywrightInstall | undefined => {
	if (playwright) {
		const pkg = readJson(join(playwright, "package.json"));
		return {
			path: playwright,
			name: "playwright",
			version: pkg?.version ?? "unknown",
			source: "option",
		};
	}

	try {
		const manifest = createRequire(import.meta.url).resolve(
			"playwright-core/package.json",
		);
		const pkg = readJson(manifest);
		if (pkg?.version) {
			return {
				path: dirname(manifest),
				name: "playwright-core",
				version: pkg.version,
				source: "bundled",
			};
		}
	} catch {}

	const own = readPackage(playwrightHome(home), "computah")[0];
	if (own) return own;

	const local: PlaywrightInstall[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		const modules = join(dir, "node_modules");
		local.push(...readPackage(modules, "project"));
		for (const entry of list(join(modules, ".pnpm"))) {
			if (/^playwright(-core)?@/.test(entry)) {
				local.push(
					...readPackage(
						join(modules, ".pnpm", entry, "node_modules"),
						"project",
					),
				);
			}
		}
		if (local.length || dirname(dir) === dir) break;
	}
	if (local[0]) return local[0];

	const user = homedir();
	const prefix = dirname(dirname(process.execPath));
	const global = [
		process.platform === "win32"
			? join(dirname(process.execPath), "node_modules")
			: join(prefix, "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/opt/homebrew/lib/node_modules",
		join(user, ".npm-global", "lib", "node_modules"),
		join(user, ".bun", "install", "global", "node_modules"),
		...(process.env.PNPM_HOME
			? [join(process.env.PNPM_HOME, "global", "5", "node_modules")]
			: []),
		join(user, "Library", "pnpm", "global", "5", "node_modules"),
		join(user, ".local", "share", "pnpm", "global", "5", "node_modules"),
		...list(join(user, ".npm", "_npx")).map((entry) =>
			join(user, ".npm", "_npx", entry, "node_modules"),
		),
	];
	return global
		.flatMap((dir) => readPackage(dir, "system"))
		.sort((a, b) => compare(b.version, a.version))[0];
};

const getAppVersion = (executable: string) => {
	const app = /^(.*?\.app)\/Contents\/MacOS\//.exec(executable)?.[1];
	if (!app) return undefined;
	try {
		const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
		return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(
			plist,
		)?.[1];
	} catch {
		return undefined;
	}
};

/** Where Playwright keeps the browsers it downloads. */
export const browserCache = () => {
	const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
	const user = homedir();
	if (configured && configured !== "0") return configured;
	if (process.platform === "darwin") {
		return join(user, "Library", "Caches", "ms-playwright");
	}
	if (process.platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? join(user, "AppData", "Local"),
			"ms-playwright",
		);
	}
	return join(
		process.env.XDG_CACHE_HOME ?? join(user, ".cache"),
		"ms-playwright",
	);
};

/**
 * Chromium-based browsers Playwright can launch: one passed in, then its own
 * downloads, newest first, then the ones installed on the system.
 */
export const findBrowsers = ({
	executablePath,
}: {
	executablePath?: string;
} = {}): BrowserInstall[] => {
	const browsers: BrowserInstall[] = [];
	if (executablePath) {
		browsers.push({
			name: "Browser",
			path: executablePath,
			source: "option",
			version: getAppVersion(executablePath),
		});
	}

	const cache = browserCache();
	const revisions = list(cache)
		.map((entry) => /^chromium-(\d+)$/.exec(entry))
		.filter((match): match is RegExpExecArray => !!match)
		.sort((a, b) => Number(b[1]) - Number(a[1]));
	for (const [entry, revision] of revisions) {
		const root = join(cache, entry);
		if (!Paths.exists(join(root, "INSTALLATION_COMPLETE"))) continue;
		const executable = list(root)
			.filter((sub) => sub.startsWith("chrome-"))
			.flatMap((sub) => [
				join(
					root,
					sub,
					"Google Chrome for Testing.app",
					"Contents",
					"MacOS",
					"Google Chrome for Testing",
				),
				join(root, sub, "Chromium.app", "Contents", "MacOS", "Chromium"),
				join(root, sub, "chrome"),
				join(root, sub, "chrome.exe"),
			])
			.find(Paths.exists);
		if (executable) {
			browsers.push({
				name: `Chromium r${revision}`,
				path: executable,
				source: "playwright",
				version: getAppVersion(executable),
			});
		}
	}

	const user = homedir();
	const system: [string, string][] = [];
	if (process.platform === "darwin") {
		for (const app of [
			"Google Chrome",
			"Microsoft Edge",
			"Brave Browser",
			"Chromium",
			"Google Chrome Beta",
			"Google Chrome Canary",
		]) {
			for (const dir of ["/Applications", join(user, "Applications")]) {
				system.push([app, join(dir, `${app}.app`, "Contents", "MacOS", app)]);
			}
		}
	} else if (process.platform === "win32") {
		const roots = [
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		].filter((root): root is string => !!root);
		for (const root of roots) {
			system.push(
				[
					"Google Chrome",
					join(root, "Google", "Chrome", "Application", "chrome.exe"),
				],
				[
					"Microsoft Edge",
					join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
				],
				[
					"Brave",
					join(
						root,
						"BraveSoftware",
						"Brave-Browser",
						"Application",
						"brave.exe",
					),
				],
			);
		}
	} else {
		const dirs = (process.env.PATH ?? "")
			.split(delimiter)
			.concat(["/usr/bin", "/usr/local/bin", "/snap/bin"]);
		for (const [name, bins] of [
			["Google Chrome", ["google-chrome", "google-chrome-stable"]],
			["Chromium", ["chromium", "chromium-browser"]],
			["Microsoft Edge", ["microsoft-edge", "microsoft-edge-stable"]],
			["Brave", ["brave-browser", "brave"]],
		] as const) {
			for (const bin of bins) {
				for (const dir of dirs) system.push([name, join(dir, bin)]);
			}
		}
	}
	const seen = new Set<string>();
	for (const [name, executable] of system) {
		if (seen.has(name) || !Paths.exists(executable)) continue;
		seen.add(name);
		browsers.push({
			name,
			path: executable,
			source: "system",
			version: getAppVersion(executable),
		});
	}

	return browsers;
};

export const toRequirement = (
	name: string,
	found: { path: string; version?: string; source: string } | undefined,
	installable: boolean,
): Requirement => ({
	name,
	found: !!found,
	...(found
		? {
				path: found.path,
				...(found.version ? { version: found.version } : {}),
				source: found.source,
			}
		: {}),
	installable,
});
