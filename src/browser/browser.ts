import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	ImageOptions,
	InstallOptions,
	InstallResult,
	Permission,
} from "../core/grammar.ts";
import { Keys } from "../core/keys.ts";
import {
	exec as defaultExec,
	download,
	type Exec,
	Paths,
} from "../core/process.ts";
import { errorMessage } from "../core/run.ts";
import {
	findBrowsers,
	findPlaywright,
	findRuntime,
	PLAYWRIGHT_VERSION,
	playwrightHome,
	type Runtime,
	toRequirement,
} from "./discover.ts";
import { driverScript } from "./driver.ts";
import type {
	BrowserRunResult,
	BrowserStatus,
	BrowserStep,
	BrowserTab,
} from "./schema.ts";

/**
 * A line-delimited connection to a driver process. The default spawns one;
 * pass your own to start it somewhere this process cannot (another host
 * process over RPC, say).
 */
export interface DriverTransport {
	send: (line: string) => void;
	onLine: (listener: (line: string) => void) => void;
	onClose: (listener: () => void) => void;
	close: () => void | Promise<void>;
}

export interface BrowserOptions {
	/** The Node (or Bun) to run the driver in. Found otherwise. */
	runtime?: string;
	/** A `playwright` or `playwright-core` package directory. Found otherwise. */
	playwright?: string;
	/** The browser to launch. Found otherwise: Playwright's Chromium, then Chrome, Edge, Brave. */
	executablePath?: string;
	/** Run without a window (default true). */
	headless?: boolean | (() => boolean);
	/** The profile sign-ins are kept in (default `<home>/browser`). */
	userDataDir?: string;
	/** The size tabs lay out at. Headless defaults to 1280×800; a shown window to its own size. */
	viewport?: { width: number; height: number };
	/** Extra arguments for the browser. */
	args?: string[];
	/** How screenshots are sized and encoded unless a step says otherwise. */
	image?: ImageOptions;
	/** Where a project's own Playwright is looked for (default the working directory). */
	cwd?: string;
	/** Where computah keeps its downloads and the profile (default `~/.computah`). */
	home?: string;
	/** Runs the installers. */
	exec?: Exec;
	/** Starts the driver, given its command and environment. */
	transport?: (
		command: string[],
		env: Record<string, string>,
	) => DriverTransport | Promise<DriverTransport>;
}

export interface Browser {
	/** What was found to drive a browser with, and whether it is enough. */
	status: (options?: { refresh?: boolean }) => Promise<BrowserStatus>;
	/** Downloads Playwright and its Chromium, whichever is missing. */
	install: (options?: InstallOptions) => Promise<InstallResult>;
	/** Nothing to grant: a browser of its own needs no OS permission. */
	permissions: () => Promise<Permission[]>;
	requestPermissions: () => Promise<Permission[]>;
	/** Runs steps in order against the active tab, stopping at the first that fails. */
	run: (input: {
		steps: BrowserStep[];
		/** Attach a screenshot of the viewport after the steps run. */
		screenshot?: boolean;
		image?: ImageOptions;
		signal?: AbortSignal;
	}) => Promise<BrowserRunResult>;
	/** The open tabs. Never starts the browser. */
	tabs: () => Promise<BrowserTab[]>;
	/** One tab as its rendered text, without switching to it. */
	readTab: (
		index: number,
		options?: { maxLength?: number },
	) => Promise<{ url: string; title: string; text: string }>;
	/** Closes the browser and its driver. The profile stays. */
	close: () => Promise<void>;
}

interface Driver {
	transport: DriverTransport;
	pending: Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>;
	next: number;
	closed: boolean;
}

const spawnTransport = (
	command: string[],
	env: Record<string, string>,
): DriverTransport => {
	const [program = "", ...args] = command;
	const child: ChildProcess = spawn(program, args, {
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});
	const closers: (() => void)[] = [];
	let closed = false;
	const onClose = () => {
		if (closed) return;
		closed = true;
		for (const listener of closers) listener();
	};
	child.on("error", onClose);
	child.on("close", onClose);
	// Written to after the driver has gone, a pipe would throw from nowhere.
	child.stdin?.on("error", () => {});
	return {
		send: (line) => {
			if (!closed) child.stdin?.write(`${line}\n`);
		},
		onLine: (listener) => {
			if (child.stdout)
				createInterface({ input: child.stdout }).on("line", listener);
		},
		onClose: (listener) => {
			if (closed) listener();
			else closers.push(listener);
		},
		close: () => {
			child.stdin?.end();
			if (!closed) child.kill();
		},
	};
};

/** Steps as the driver takes them: keys and modifiers named Playwright's way. */
const prepare = (step: BrowserStep): BrowserStep => {
	if (step.action === "press") {
		return { ...step, keys: Keys.parse(step.keys).map(Keys.format).join(" ") };
	}
	if ("modifiers" in step && step.modifiers) {
		return { ...step, modifiers: Keys.modifiers(step.modifiers) };
	}
	return step;
};

export const createBrowser = (options: BrowserOptions = {}): Browser => {
	const run = options.exec ?? defaultExec;
	let status: Promise<BrowserStatus> | undefined;
	let runtime: Runtime | undefined;
	let driver: Promise<Driver> | undefined;
	/** What a headed launch that found no desktop taught, until rechecked. */
	let display: { available: boolean; error?: string } | undefined;

	const start = async (): Promise<Driver> => {
		runtime ??= await findRuntime({
			runtime: options.runtime,
			exec: options.exec,
		});
		const env = { NODE_NO_WARNINGS: "1", ...runtime.env };
		const transport = await (options.transport ?? spawnTransport)(
			[runtime.path, "-e", driverScript],
			env,
		);
		const started: Driver = {
			transport,
			pending: new Map(),
			next: 1,
			closed: false,
		};
		transport.onLine((line) => {
			let message: {
				id?: number;
				result?: unknown;
				error?: { message: string };
			};
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof message.id !== "number") return;
			const request = started.pending.get(message.id);
			if (!request) return;
			started.pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message));
			else request.resolve(message.result);
		});
		transport.onClose(() => {
			started.closed = true;
			for (const request of started.pending.values()) {
				request.reject(new Error("The browser driver exited"));
			}
			started.pending.clear();
			void driver?.then(
				(current) => {
					if (current === started) driver = undefined;
				},
				() => {},
			);
		});
		return started;
	};

	const getDriver = () => {
		if (!driver) {
			const starting = start();
			driver = starting;
			starting.catch(() => {
				if (driver === starting) driver = undefined;
			});
		}
		return driver;
	};

	const request = async <T>(
		target: Driver,
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> => {
		signal?.throwIfAborted();
		if (target.closed) throw new Error("The browser driver exited");
		const id = target.next++;
		const result = new Promise<T>((resolve, reject) => {
			target.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});
		});
		const onAbort = () => {
			// The driver stops before its next step; the call is over now.
			target.transport.send(
				JSON.stringify({ jsonrpc: "2.0", method: "abort", params: { id } }),
			);
			target.pending.get(id)?.reject(new Error("Aborted"));
			target.pending.delete(id);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			target.transport.send(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			);
			return await result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const detect = async (): Promise<BrowserStatus> => {
		const found = await findRuntime({
			runtime: options.runtime,
			exec: options.exec,
		}).catch(() => undefined);
		runtime = found;
		const playwright = findPlaywright({
			playwright: options.playwright,
			cwd: options.cwd,
			home: options.home,
			runtime: found?.path,
		});
		const browsers = findBrowsers({ executablePath: options.executablePath });

		// Asked of a driver that is already there; starting one just to ask
		// would cost a process for every status check.
		const running = await driver?.catch(() => undefined);
		if (running && !running.closed) {
			display = await request<typeof display>(running, "display", {}).catch(
				() => display,
			);
		}

		const error = !found
			? "No Node.js was found to run Playwright in. Install Node.js, then recheck."
			: !playwright
				? "Playwright was not found. `install()` downloads it."
				: !browsers.length
					? "No Chromium-based browser was found. `install()` downloads Chromium, or install Chrome."
					: undefined;
		return {
			available: !error,
			...(error ? { error } : {}),
			runtime: toRequirement("node", found, false),
			playwright: toRequirement("playwright", playwright, true),
			browsers,
			...(browsers[0] ? { browser: browsers[0] } : {}),
			display: display ?? staticDisplay(),
			permissions: [],
		};
	};

	const getStatus = ({ refresh = false } = {}) => {
		if (refresh) {
			status = undefined;
			display = undefined;
		}
		status ??= detect().catch((error: unknown): BrowserStatus => {
			status = undefined;
			return {
				available: false,
				error: errorMessage(error),
				runtime: { name: "node", found: false },
				playwright: { name: "playwright", found: false, installable: true },
				browsers: [],
				display: staticDisplay(),
				permissions: [],
			};
		});
		return status;
	};

	const close = async () => {
		const current = await driver?.catch(() => undefined);
		driver = undefined;
		if (!current) return;
		await Promise.race([
			request(current, "close", {}).catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		await current.transport.close();
	};

	return {
		status: getStatus,

		install: async ({ signal, onProgress }: InstallOptions = {}) => {
			const installed: string[] = [];
			let output = "";
			try {
				let found = await getStatus({ refresh: true });
				if (!found.runtime.found || !found.runtime.path) {
					return {
						ok: false,
						installed,
						error:
							"No Node.js was found to run Playwright in. Install Node.js, then try again.",
					};
				}

				if (!found.playwright.found) {
					// playwright-core has no dependencies of its own, so its
					// tarball is all of it: no package manager needed.
					const home = playwrightHome(options.home);
					const target = join(home, "playwright-core");
					const registry = `https://registry.npmjs.org/playwright-core/${PLAYWRIGHT_VERSION}`;
					onProgress?.({
						phase: "download",
						message: `Fetching playwright-core ${PLAYWRIGHT_VERSION}`,
					});
					const response = await fetch(registry, { signal });
					if (!response.ok) {
						throw new Error(
							`Could not look up playwright-core: HTTP ${response.status}`,
						);
					}
					const { dist } = (await response.json()) as {
						dist: { tarball: string; integrity: string };
					};
					const archive = join(home, "playwright-core.tgz");
					await download({
						url: dist.tarball,
						file: archive,
						integrity: dist.integrity,
						signal,
						onProgress,
					});
					onProgress?.({
						phase: "extract",
						message: "Unpacking playwright-core",
					});
					await rm(target, { recursive: true, force: true });
					await mkdir(target, { recursive: true });
					const unpacked = await run({
						program: "tar",
						args: ["-xzf", archive, "-C", target, "--strip-components=1"],
						signal,
					});
					await rm(archive, { force: true });
					if (unpacked.code !== 0) {
						throw new Error(
							`Could not unpack playwright-core: ${unpacked.stderr.trim()}`,
						);
					}
					installed.push(`playwright-core@${PLAYWRIGHT_VERSION}`);
					found = await getStatus({ refresh: true });
				}

				if (!found.browsers.length && found.playwright.path) {
					onProgress?.({ phase: "install", message: "Downloading Chromium" });
					const result = await run({
						program: found.runtime.path ?? "node",
						args: [
							join(found.playwright.path, "cli.js"),
							"install",
							"chromium",
						],
						env: runtime?.env,
						signal,
						onOutput: (chunk) =>
							onProgress?.({ phase: "install", message: chunk.trimEnd() }),
					});
					output = `${result.stdout}${result.stderr}`.trim().slice(-4_000);
					if (result.code !== 0) {
						throw new Error("Playwright could not download Chromium.");
					}
					installed.push("chromium");
					found = await getStatus({ refresh: true });
				}

				return {
					ok: found.available,
					installed,
					...(found.error ? { error: found.error } : {}),
					...(output ? { output } : {}),
				};
			} catch (error) {
				return {
					ok: false,
					installed,
					error: errorMessage(error),
					...(output ? { output } : {}),
				};
			}
		},

		permissions: async () => [],
		requestPermissions: async () => [],

		run: async ({ steps, screenshot, image, signal }) => {
			const found = await getStatus();
			const browser = found.browser ?? found.browsers[0];
			if (!found.available || !found.playwright.path || !browser) {
				throw new Error(found.error ?? "No browser is available");
			}
			const headless =
				typeof options.headless === "function"
					? options.headless()
					: (options.headless ?? true);
			const target = await getDriver();
			const result = await request<BrowserRunResult>(
				target,
				"run",
				{
					steps: steps.map(prepare),
					screenshot,
					image: { maxDimension: 1568, ...options.image, ...image },
					playwright: found.playwright.path,
					executablePath: browser.path,
					headless,
					userDataDir:
						options.userDataDir ?? join(Paths.data(options.home), "browser"),
					viewport: options.viewport,
					args: options.args,
				},
				signal,
			);
			// A headed launch that found no desktop is only learned by trying,
			// so the status is brought up to date with it.
			if (!headless && result.notice && found.display.available) {
				display = await request<typeof display>(target, "display", {}).catch(
					() => display,
				);
				if (display) status = Promise.resolve({ ...found, display });
			}
			return result;
		},

		tabs: async () => {
			const current = await driver?.catch(() => undefined);
			if (!current || current.closed) return [];
			const { tabs } = await request<{ tabs: BrowserTab[] }>(
				current,
				"listTabs",
				{},
			);
			return tabs;
		},

		readTab: async (index, { maxLength }: { maxLength?: number } = {}) => {
			const current = await driver?.catch(() => undefined);
			if (!current || current.closed) {
				throw new Error("The browser is not running");
			}
			return await request(current, "readTab", { index, maxLength });
		},

		close,
	};
};

/**
 * Whether a browser window can be shown here, as far as can be told without
 * trying: macOS and Windows always have a desktop; on Linux it takes an X or
 * Wayland display whose socket is there.
 */
const staticDisplay = (): { available: boolean; error?: string } => {
	if (process.platform !== "linux") return { available: true };
	const {
		WAYLAND_DISPLAY: wayland,
		DISPLAY: x,
		XDG_RUNTIME_DIR: dir,
	} = process.env;
	if (wayland) {
		const socket = wayland.startsWith("/") ? wayland : join(dir ?? "", wayland);
		if (Paths.exists(socket)) return { available: true };
	}
	if (x) {
		const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(x);
		if (!local || Paths.exists(`/tmp/.X11-unix/X${local[1]}`)) {
			return { available: true };
		}
	}
	return {
		available: false,
		error:
			!x && !wayland
				? "No desktop to show it on ($DISPLAY and $WAYLAND_DISPLAY are unset)"
				: `The desktop is not reachable (${[x && `DISPLAY=${x}`, wayland && `WAYLAND_DISPLAY=${wayland}`].filter(Boolean).join(", ")} has no socket)`,
	};
};
