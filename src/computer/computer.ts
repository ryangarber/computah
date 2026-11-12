import type {
	Image,
	ImageOptions,
	InstallOptions,
	InstallResult,
	Permission,
} from "../core/grammar.ts";
import { type Chord, Keys } from "../core/keys.ts";
import type { Exec } from "../core/process.ts";
import { errorMessage, runSteps, StepError, sleep } from "../core/run.ts";
import {
	Driver,
	type DriverChoice,
	type DriverHandle,
	type DriverSdk,
	type ToolOutput,
} from "./driver.ts";
import { Outline, type OutlineElement } from "./outline.ts";
import type {
	ComputerCursor,
	ComputerRunResult,
	ComputerStatus,
	ComputerStep,
	ComputerWindow,
} from "./schema.ts";

/** How long a launched app has to show a window. */
const OPEN_MS = 15_000;
const POLL_MS = 250;
/** Long enough for an app to repaint and its tree to catch up. */
const SETTLE_MS = 150;
const MAX_ELEMENTS = 1_500;
const MAX_DEPTH = 40;
const MAX_EDGE = 1_280;

export interface ComputerOptions {
	/** Which driver to use (default `auto`). */
	driver?: DriverChoice;
	/** The `@trycua/cua-driver` module, where the host loads it its own way. */
	sdk?: DriverSdk;
	/** Where the Cua Driver app is, if not where its installer puts it. */
	app?: string;
	/** Where its `cua-driver` command line is. */
	cli?: string;
	/**
	 * Start the Cua Driver app's service when it is installed but not
	 * running (default true).
	 */
	launch?: boolean;
	/** Show the virtual cursor where there is one (default true). */
	cursor?: boolean;
	/**
	 * A name for this controller's run of the desktop. The virtual cursor
	 * wears it as a badge, and is colored by it.
	 */
	session?: string;
	/** How screenshots are sized and encoded unless a step says otherwise. */
	image?: ImageOptions;
	/** Runs the installer. */
	exec?: Exec;
}

export interface Computer {
	/** Whether the computer can be controlled now, how, and what is missing. */
	status: (options?: { refresh?: boolean }) => Promise<ComputerStatus>;
	/**
	 * Downloads and installs the Cua Driver app, which draws the virtual
	 * cursor. Its own permissions are asked for separately, with
	 * `requestPermissions({ owner: "app" })`.
	 */
	install: (
		options?: InstallOptions & { version?: string },
	) => Promise<InstallResult>;
	/** Every grant that matters, the host's and the app's, without asking. */
	permissions: () => Promise<Permission[]>;
	/**
	 * Raises the system's permission prompts: for the host itself by default,
	 * or for the Cua Driver app. `settings` also opens the Screen Recording
	 * pane where macOS will not prompt for it.
	 */
	requestPermissions: (options?: {
		owner?: "host" | "app";
		settings?: boolean;
	}) => Promise<Permission[]>;
	/** Runs steps in order against the target window, stopping at the first that fails. */
	run: (input: {
		/** The window to act on: an id (`w3`), or an app name or title. Defaults to the last one used. */
		window?: string;
		steps: ComputerStep[];
		/** Attach a screenshot of the target window after the steps run. */
		screenshot?: boolean;
		image?: ImageOptions;
		signal?: AbortSignal;
	}) => Promise<ComputerRunResult>;
	windows: (options?: { app?: string }) => Promise<ComputerWindow[]>;
	/** Ends this controller's session and its cursor, and lets go of the driver. */
	close: () => Promise<void>;
}

interface Target {
	id: string;
	pid: number;
	windowId: number;
	app: string;
	title?: string;
}

interface Snapshot {
	windowId: number;
	elements: OutlineElement[];
	keys: Map<number, string>;
	markdown: string;
	truncated: boolean;
}

/** What `x`/`y` are pixels of: the latest screenshot, whichever it was. */
type FrameKind = "window" | "zoom" | "screen";

type Resolved =
	| { kind: "element"; element: OutlineElement }
	| { kind: "point"; x: number; y: number };

const isMac = process.platform === "darwin";

/** A modifier as the driver names it. */
const modifierName = (modifier: Chord["modifiers"][number]) =>
	({
		Control: "ctrl",
		Alt: isMac ? "option" : "alt",
		Shift: "shift",
		Meta: isMac ? "cmd" : "super",
	})[modifier];

const KEY_NAMES: Record<string, string> = {
	Enter: "return",
	Tab: "tab",
	Escape: "escape",
	// What Apple's keyboards call the key that deletes backwards.
	Backspace: "delete",
	Delete: "forwarddelete",
	Space: "space",
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	Home: "home",
	End: "end",
	PageUp: "pageup",
	PageDown: "pagedown",
};

/** A chord as the driver's key tools take it. */
const toDriverKeys = ({ key, modifiers }: Chord) => {
	const held = modifiers.map(modifierName);
	let name = KEY_NAMES[key] ?? (/^F\d+$/.test(key) ? key.toLowerCase() : key);
	if (/^[A-Z]$/.test(name)) {
		// A capital alone is its letter with Shift held; in a shortcut it is
		// only how shortcuts are written (`Mod+C`).
		if (!held.length) held.push("shift");
		name = name.toLowerCase();
	}
	return { key: name, modifiers: held };
};

/** The first thing a driver said, without the mark it leads with. */
const summarize = (output: ToolOutput) =>
	(typeof output.data.summary === "string" ? output.data.summary : output.text)
		.split("\n\n")[0]
		?.replace(/^[^\p{L}\p{N}"'([`]+/u, "")
		.trim() || undefined;

/** A driver's advice, in the words of this grammar rather than its own tools'. */
const translate = (message: string) =>
	message
		.replace(/delivery_mode:\s*"foreground"/g, "`foreground: true`")
		.replace(/\bbring_to_front\b/g, "the `window` step's `activate`")
		.replace(/\bget_window_state\b/g, "`read`")
		.replace(/\binvoke_menu\b/g, "`menu`")
		.replace(/\bset_value\b/g, "`type`");

const fail = (output: ToolOutput): never => {
	throw new StepError(
		translate(output.text.split("\n\n")[0]?.trim() ?? "") ||
			"The driver refused the action.",
		output.code ? { code: output.code } : undefined,
	);
};

/** What a step did, or its failure. */
const done = (output: ToolOutput) =>
	output.isError ? fail(output) : summarize(output);

const looksLikeBundleId = (app: string) =>
	/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(app) && !app.endsWith(".app");

const toPermissions = (
	owner: string,
	grants: { accessibility: boolean; screenRecording: boolean } | undefined,
): Permission[] =>
	grants
		? [
				{ name: "accessibility", granted: grants.accessibility, owner },
				{ name: "screen-recording", granted: grants.screenRecording, owner },
			]
		: [];

export const createComputer = (options: ComputerOptions = {}): Computer => {
	const choice = options.driver ?? "auto";

	let loaded: ReturnType<typeof Driver.load> | undefined;
	let resolving: Promise<DriverHandle> | undefined;
	/** What was learned of the app's service while choosing a driver. */
	let appState: {
		reachable: boolean;
		grants?: { accessibility: boolean; screenRecording: boolean };
	} = { reachable: false };

	let target: Target | undefined;
	const windowIds = new Map<number, string>();
	let nextWindow = 0;
	let snapshot: Snapshot | undefined;
	/** Whether something was done since the snapshot was taken. */
	let dirty = true;
	const refs = new Map<
		string,
		{ windowId: number; index: number; key: string }
	>();
	let frame: { kind: FrameKind; windowId?: number } | undefined;
	/** Runs share one target and one cursor, so they go one at a time. */
	let queue: Promise<unknown> = Promise.resolve();

	const load = () => {
		loaded ??= Driver.load(options.sdk);
		return loaded;
	};

	const sdkOrThrow = async () => {
		const { sdk, error } = await load();
		if (!sdk) {
			throw new Error(
				`The computer driver could not be loaded on this machine: ${error ?? "unknown error"}`,
			);
		}
		return sdk;
	};

	const choose = async (): Promise<DriverHandle> => {
		const sdk = await sdkOrThrow();
		const { session } = options;
		if (typeof choice === "object") {
			if ("binaryPath" in choice) {
				return await Driver.embedded({ sdk, ...choice, session });
			}
			return Driver.external(sdk, choice, session);
		}
		if (choice === "in-process") return Driver.inProcess(sdk, session);

		const found = Driver.discover(options);
		const service =
			isMac || choice === "app"
				? await Driver.app({
						sdk,
						app: found.app,
						session,
						launch: options.launch ?? true,
					}).catch(() => undefined)
				: undefined;
		appState = { reachable: !!service };
		if (service) {
			appState.grants = await Driver.permissions(service);
			const permitted =
				appState.grants?.accessibility && appState.grants.screenRecording;
			if (choice === "app" || permitted) return service;
			await service.close();
		}
		if (choice === "app") {
			throw new Error(
				found.app
					? "The Cua Driver app is installed, but its service could not be reached."
					: "The Cua Driver app is not installed. `install()` downloads it.",
			);
		}
		return Driver.inProcess(sdk, session);
	};

	const getDriver = () => {
		if (!resolving) {
			const starting = choose().then(async (handle) => {
				if (options.cursor === false && handle.mode !== "in-process") {
					await handle.call("set_agent_cursor_enabled", { enabled: false });
				}
				return handle;
			});
			resolving = starting;
			starting.catch(() => {
				if (resolving === starting) resolving = undefined;
			});
		}
		return resolving;
	};

	const release = async () => {
		const current = await resolving?.catch(() => undefined);
		resolving = undefined;
		await current?.close().catch(() => {});
	};

	// --- windows --------------------------------------------------------------

	const toWindow = (
		raw: Record<string, unknown>,
	): (ComputerWindow & { windowId: number; z: number }) | undefined => {
		const windowId = raw.window_id;
		const pid = raw.pid;
		if (typeof windowId !== "number" || typeof pid !== "number")
			return undefined;
		let id = windowIds.get(windowId);
		if (!id) {
			id = `w${++nextWindow}`;
			windowIds.set(windowId, id);
		}
		const bounds = raw.bounds as Record<string, unknown> | undefined;
		const title = typeof raw.title === "string" ? raw.title : "";
		return {
			id,
			windowId,
			pid,
			app: typeof raw.app_name === "string" ? raw.app_name : "",
			...(title ? { title } : {}),
			...(bounds &&
			typeof bounds.width === "number" &&
			typeof bounds.height === "number" &&
			typeof bounds.x === "number" &&
			typeof bounds.y === "number"
				? {
						bounds: {
							x: bounds.x,
							y: bounds.y,
							width: bounds.width,
							height: bounds.height,
						},
					}
				: {}),
			visible: raw.is_on_screen === true,
			z: typeof raw.z_index === "number" ? raw.z_index : -1,
		};
	};

	const listWindows = async (
		driver: DriverHandle,
		filter: { app?: string; pid?: number } = {},
		signal?: AbortSignal,
	) => {
		const output = await driver.call("list_windows", filter, signal);
		if (output.isError) fail(output);
		const raw = Array.isArray(output.data.windows) ? output.data.windows : [];
		return (
			(raw as Record<string, unknown>[])
				.filter((window) => window.layer === undefined || window.layer === 0)
				.map(toWindow)
				.filter((window) => !!window)
				// Front to back, so the first match of a name is the one in view.
				.sort((a, b) => Number(b.visible) - Number(a.visible) || b.z - a.z)
		);
	};

	const publicWindow = ({
		windowId: _windowId,
		z: _z,
		...window
	}: NonNullable<ReturnType<typeof toWindow>>): ComputerWindow => window;

	const setTarget = (window: NonNullable<ReturnType<typeof toWindow>>) => {
		if (target?.windowId !== window.windowId) {
			snapshot = undefined;
			frame = undefined;
		}
		target = {
			id: window.id,
			pid: window.pid,
			windowId: window.windowId,
			app: window.app,
			...(window.title ? { title: window.title } : {}),
		};
		dirty = true;
		return target;
	};

	/** A window by its id (`w3`), or the frontmost whose app or title has the text. */
	const findWindow = async (
		driver: DriverHandle,
		spec: string,
		signal?: AbortSignal,
	) => {
		const windows = await listWindows(driver, {}, signal);
		const wanted = spec.trim().toLowerCase();
		const usable = windows.filter((w) => (w.bounds?.width ?? 0) > 0);
		const found =
			windows.find((w) => w.id === wanted) ??
			usable.find((w) => w.app.toLowerCase() === wanted) ??
			usable.find((w) => w.title?.toLowerCase() === wanted) ??
			usable.find((w) => w.app.toLowerCase().includes(wanted)) ??
			usable.find((w) => w.title?.toLowerCase().includes(wanted));
		if (!found) {
			throw new Error(
				`No window matches "${spec}". Open windows: ${
					usable
						.slice(0, 20)
						.map((w) => `${w.id} ${w.app}${w.title ? ` "${w.title}"` : ""}`)
						.join(", ") || "none"
				}.`,
			);
		}
		return found;
	};

	const needTarget = () => {
		if (!target) {
			throw new Error(
				"There is no window to act on: `open` an app, or name one with `window`.",
			);
		}
		return target;
	};

	// --- reading --------------------------------------------------------------

	/**
	 * Whether the driver takes a screenshot's format and quality. The Windows
	 * driver has neither (its screenshots are always PNG) and refuses a call
	 * that names them, so one refusal stops them being sent again.
	 */
	let encodes = true;
	const imageArgs = (image: ImageOptions = {}) => ({
		max_image_dimension: image.maxDimension ?? MAX_EDGE,
		...(encodes ? { screenshot_format: image.format ?? "jpeg" } : {}),
		...(encodes && image.quality && (image.format ?? "jpeg") === "jpeg"
			? { screenshot_quality: Math.min(image.quality, 95) }
			: {}),
	});
	const refusesEncoding = (output: ToolOutput) =>
		encodes &&
		output.isError &&
		/unknown argument (screenshot_format|screenshot_quality)/.test(output.text);

	const toImage = (output: ToolOutput): Image | undefined => {
		const [image] = output.images;
		if (!image) return undefined;
		const width = output.data.screenshot_width ?? output.data.width;
		const height = output.data.screenshot_height ?? output.data.height;
		return {
			...image,
			...(typeof width === "number" ? { width } : {}),
			...(typeof height === "number" ? { height } : {}),
		};
	};

	/** Reads the target window: its tree, and its pixels when asked. */
	const read = async (
		driver: DriverHandle,
		{
			screenshot,
			signal,
		}: {
			screenshot?: ImageOptions;
			signal?: AbortSignal;
		} = {},
	) => {
		const window = needTarget();
		const call = () =>
			driver.call(
				"get_window_state",
				{
					pid: window.pid,
					window_id: window.windowId,
					include_screenshot: !!screenshot,
					tree_format: "both",
					max_elements: MAX_ELEMENTS,
					max_depth: MAX_DEPTH,
					timeout_ms: 5_000,
					...(screenshot ? imageArgs(screenshot) : {}),
				},
				signal,
			);
		let output = await call();
		if (screenshot && refusesEncoding(output)) {
			encodes = false;
			output = await call();
		}
		if (output.isError) {
			if (output.code === "window_id_not_found") target = undefined;
			fail(output);
		}
		const markdown =
			typeof output.data.tree_markdown === "string"
				? output.data.tree_markdown
				: "";
		const elements = Outline.elements(output.data.elements, markdown);
		const taken: Snapshot = {
			windowId: window.windowId,
			elements,
			keys: Outline.keys(elements),
			markdown,
			truncated: output.data.truncated === true,
		};
		snapshot = taken;
		dirty = false;
		const image = screenshot ? toImage(output) : undefined;
		if (image) frame = { kind: "window", windowId: window.windowId };
		return { snapshot: taken, image, output };
	};

	/** The target window's tree as it is now. */
	const current = async (driver: DriverHandle, signal?: AbortSignal) => {
		const window = needTarget();
		if (snapshot && !dirty && snapshot.windowId === window.windowId) {
			return snapshot;
		}
		return (await read(driver, { signal })).snapshot;
	};

	const remember = (taken: Snapshot) => {
		refs.clear();
		for (const element of taken.elements) {
			refs.set(`e${element.index}`, {
				windowId: taken.windowId,
				index: element.index,
				key: taken.keys.get(element.index) ?? "",
			});
		}
	};

	const byRef = async (
		driver: DriverHandle,
		ref: string,
		signal?: AbortSignal,
	) => {
		const window = needTarget();
		const known = refs.get(ref.trim());
		if (!known || known.windowId !== window.windowId) {
			throw new Error(
				`No element ${ref} in this window; \`read\` it for fresh refs.`,
			);
		}
		const tree = await current(driver, signal);
		// Usually still the same row; otherwise wherever its key went.
		const same = tree.elements.find((element) => element.index === known.index);
		const element =
			same && tree.keys.get(same.index) === known.key
				? same
				: tree.elements.find(
						(candidate) => tree.keys.get(candidate.index) === known.key,
					);
		if (!element) {
			throw new Error(
				`Element ${ref} is no longer in the window; \`read\` it again for fresh refs.`,
			);
		}
		return element;
	};

	const bySelector = async (
		driver: DriverHandle,
		selector: string,
		signal?: AbortSignal,
	) => {
		const tree = await current(driver, signal);
		const [element] = Outline.select(tree.elements, selector);
		if (!element) {
			throw new Error(
				`Nothing in the window matches ${selector}${tree.truncated ? " (the window has more elements than were read)" : ""}.`,
			);
		}
		return element;
	};

	/** What a step points at: an element, a point, or nothing. */
	const resolve = async (
		driver: DriverHandle,
		step: { ref?: string; selector?: string; x?: number; y?: number },
		signal?: AbortSignal,
	): Promise<Resolved | undefined> => {
		if (step.ref) {
			return {
				kind: "element",
				element: await byRef(driver, step.ref, signal),
			};
		}
		if (step.selector) {
			return {
				kind: "element",
				element: await bySelector(driver, step.selector, signal),
			};
		}
		if (typeof step.x === "number" && typeof step.y === "number") {
			if (!frame) {
				throw new Error(
					"x and y are pixels of a screenshot: take a `screenshot` first.",
				);
			}
			return { kind: "point", x: step.x, y: step.y };
		}
		return undefined;
	};

	/** The driver arguments that say where: an element's token, or a point. */
	const where = (resolved: Resolved | undefined, zoomable = false) => {
		const window = needTarget();
		const base = { pid: window.pid, window_id: window.windowId };
		if (!resolved) return base;
		if (resolved.kind === "element") {
			return { element_token: resolved.element.token };
		}
		if (frame?.kind === "screen") {
			return { scope: "desktop", x: resolved.x, y: resolved.y };
		}
		if (frame?.kind === "zoom") {
			if (!zoomable) {
				throw new Error(
					"x and y are pixels of a zoomed screenshot, which this action cannot use: take a `screenshot` of the window first.",
				);
			}
			return { ...base, x: resolved.x, y: resolved.y, from_zoom: true };
		}
		return { ...base, x: resolved.x, y: resolved.y };
	};

	/** Where a target is in the window's screenshot, taking one if there is none. */
	const pixels = async (
		driver: DriverHandle,
		step: { ref?: string; selector?: string; x?: number; y?: number },
		image: ImageOptions | undefined,
		signal?: AbortSignal,
	) => {
		let resolved = await resolve(driver, step, signal);
		if (!resolved) return undefined;
		if (resolved.kind === "point") return { x: resolved.x, y: resolved.y };
		if (frame?.kind !== "window" || !resolved.element.frame) {
			// Elements are placed in a screenshot's pixels only once one exists.
			await read(driver, { screenshot: image ?? {}, signal });
			resolved = await resolve(driver, step, signal);
		}
		const point =
			resolved?.kind === "element"
				? Outline.center(resolved.element)
				: undefined;
		if (!point) {
			throw new Error("The element has no place in the window to point at.");
		}
		return point;
	};

	// --- steps ----------------------------------------------------------------

	const execute = async (
		driver: DriverHandle,
		step: ComputerStep,
		context: {
			screenshots: Image[];
			image: ImageOptions;
			signal?: AbortSignal;
		},
	): Promise<unknown> => {
		const { signal } = context;
		const delivery = (foreground: boolean | undefined) => {
			if (!foreground) return {};
			const window = needTarget();
			return {
				delivery_mode: "foreground",
				pid: window.pid,
				window_id: window.windowId,
			};
		};
		const act = async (name: string, args: Record<string, unknown>) => {
			const output = await driver.call(name, args, signal);
			dirty = true;
			return done(output);
		};

		switch (step.action) {
			case "windows": {
				const windows = await listWindows(
					driver,
					step.app ? { app: step.app } : {},
					signal,
				);
				return windows
					.filter((window) => (window.bounds?.width ?? 0) > 0)
					.map(publicWindow);
			}

			case "open": {
				const output = await driver.call(
					"launch_app",
					{
						...(looksLikeBundleId(step.app)
							? { bundle_id: step.app }
							: { name: step.app }),
						...(step.urls?.length ? { urls: step.urls } : {}),
						...(step.args?.length ? { additional_arguments: step.args } : {}),
					},
					signal,
				);
				if (output.isError) fail(output);
				const pid = output.data.pid;
				if (typeof pid !== "number") {
					throw new Error(
						`${step.app} was opened, but the driver did not say as what.`,
					);
				}
				const timeout = step.timeout ?? OPEN_MS;
				const started = Date.now();
				for (;;) {
					const [window] = (await listWindows(driver, { pid }, signal)).filter(
						(candidate) => (candidate.bounds?.width ?? 0) > 0,
					);
					if (window) {
						setTarget(window);
						return publicWindow(window);
					}
					if (Date.now() - started >= timeout) {
						throw new Error(
							`${step.app} is running (pid ${pid}) but showed no window within ${timeout}ms.`,
						);
					}
					await sleep(POLL_MS, signal);
				}
			}

			case "read": {
				// Always the whole window, so refs mean the same whatever part
				// of it was asked for; narrowing is done on what came back.
				const { snapshot: taken } = await read(driver, { signal });
				remember(taken);
				let outline = taken.markdown;
				if (step.ref) {
					const element = await byRef(driver, step.ref, signal);
					outline = Outline.subtree(outline, element.index);
				}
				if (step.depth) outline = Outline.shallow(outline, step.depth);
				if (step.find) outline = Outline.filter(outline, step.find);
				const text = Outline.withRefs(outline) || "(nothing to read)";
				const max = step.maxLength ?? 20_000;
				return text.length > max
					? `${text.slice(0, max)}\n… ${text.length - max} more characters; read a narrower ref, use \`find\`, or raise maxLength`
					: `${text}${taken.truncated ? "\n… the window has more elements than were read; use `find` or a ref to narrow it" : ""}`;
			}

			case "click": {
				const resolved = await resolve(driver, step, signal);
				if (!resolved)
					throw new Error("click needs a ref, selector, or x and y");
				const button = step.button ?? "left";
				const count = step.count ?? 1;
				const modifiers = Keys.modifiers(step.modifiers).map(modifierName);
				const extra = {
					...(modifiers.length ? { modifier: modifiers } : {}),
					...delivery(step.foreground),
				};
				if (resolved.kind === "element") {
					const at = { element_token: resolved.element.token };
					if (count === 2 && button === "left") {
						return await act("double_click", {
							...at,
							...delivery(step.foreground),
						});
					}
					if (count === 1) {
						return await act("click", { ...at, button, ...extra });
					}
					// Only a point can be clicked more than twice.
					const point = await pixels(driver, step, context.image, signal);
					return await act("click", {
						...where({ kind: "point", ...(point ?? { x: 0, y: 0 }) }, true),
						button,
						count,
						...extra,
					});
				}
				return await act("click", {
					...where(resolved, true),
					button,
					...(count > 1 ? { count } : {}),
					...extra,
				});
			}

			case "hover": {
				const point = await pixels(driver, step, context.image, signal);
				if (!point) throw new Error("hover needs a ref, selector, or x and y");
				const window = needTarget();
				if (frame?.kind === "screen" || frame?.kind === "zoom") {
					throw new Error(
						"hover takes pixels of a window screenshot: take a `screenshot` of the window first.",
					);
				}
				return await act("move_cursor", {
					target: {
						kind: "window",
						pid: window.pid,
						window_id: window.windowId,
					},
					...point,
				});
			}

			case "drag": {
				const from = await pixels(driver, step, context.image, signal);
				if (!from) throw new Error("drag needs a ref, selector, or x and y");
				const to = await pixels(driver, step.to, context.image, signal);
				if (!to) throw new Error("drag needs somewhere to let go, in `to`");
				const window = needTarget();
				const modifiers = Keys.modifiers(step.modifiers).map(modifierName);
				return await act("drag", {
					...(frame?.kind === "screen"
						? { scope: "desktop" }
						: { pid: window.pid, window_id: window.windowId }),
					...(frame?.kind === "zoom" ? { from_zoom: true } : {}),
					from_x: from.x,
					from_y: from.y,
					to_x: to.x,
					to_y: to.y,
					...(step.button ? { button: step.button } : {}),
					...(modifiers.length ? { modifier: modifiers } : {}),
					...delivery(step.foreground),
				});
			}

			case "type": {
				const resolved = await resolve(driver, step, signal);
				const window = needTarget();
				let result: string | undefined;
				if (resolved?.kind === "element" && step.clear !== false) {
					// Setting the value replaces it; where an app will not have
					// its value set, the text is typed into the element instead.
					const set = await driver.call(
						"set_value",
						{ element_token: resolved.element.token, value: step.text },
						signal,
					);
					dirty = true;
					result = set.isError
						? await act("type_text", {
								element_token: resolved.element.token,
								text: step.text,
								...delivery(step.foreground),
							})
						: summarize(set);
				} else {
					result = await act("type_text", {
						...where(resolved, true),
						text: step.text,
						...delivery(step.foreground),
					});
				}
				if (step.submit) {
					await act("press_key", {
						pid: window.pid,
						window_id: window.windowId,
						key: "return",
						...delivery(step.foreground),
					});
				}
				return result;
			}

			case "press": {
				const resolved = await resolve(driver, step, signal);
				const chords = Keys.parse(step.keys).map(toDriverKeys);
				let result: string | undefined;
				for (const [index, chord] of chords.entries()) {
					const last = index === chords.length - 1;
					const at = {
						...where(resolved),
						...delivery(step.foreground),
						// Only the last key waits to see what the keys brought up.
						...(last ? {} : { post_action_wait: "none" }),
					};
					result = chord.modifiers.length
						? await act("hotkey", {
								...at,
								keys: [...chord.modifiers, chord.key],
							})
						: await act("press_key", { ...at, key: chord.key });
				}
				return result;
			}

			case "scroll": {
				const resolved = await resolve(driver, step, signal);
				const dy = step.dy ?? (step.dx ? 0 : 5);
				const dx = step.dx ?? 0;
				let result: string | undefined;
				for (const [amount, forward, back] of [
					[dy, "down", "up"],
					[dx, "right", "left"],
				] as const) {
					if (!amount) continue;
					result = await act("scroll", {
						...where(resolved),
						direction: amount > 0 ? forward : back,
						amount: Math.abs(Math.round(amount)),
						...delivery(step.foreground),
					});
				}
				return result;
			}

			case "wait": {
				const started = Date.now();
				const elapsed = () => Date.now() - started;
				if (!step.selector && step.text === undefined) {
					await sleep(Math.min(step.ms ?? 1_000, 30_000), signal);
					return { elapsed: elapsed() };
				}
				const timeout = Math.min(step.timeout ?? 10_000, 60_000);
				const what = step.selector ?? JSON.stringify(step.text);
				for (;;) {
					const { snapshot: tree } = await read(driver, { signal });
					const there = step.selector
						? Outline.select(tree.elements, step.selector).length > 0
						: Outline.includes(tree.markdown, step.text ?? "");
					if (there !== !!step.gone) return { elapsed: elapsed() };
					if (elapsed() >= timeout) {
						throw new Error(
							`Timed out after ${timeout}ms waiting for ${what} to ${step.gone ? "go" : "appear"}.`,
						);
					}
					await sleep(POLL_MS, signal);
				}
			}

			case "screenshot": {
				const image = { ...context.image, ...step };
				let shot: Image | undefined;
				if (step.screen) {
					const output = await driver.call(
						"get_desktop_state",
						{ max_image_dimension: image.maxDimension ?? MAX_EDGE },
						signal,
					);
					if (output.isError) fail(output);
					shot = toImage(output);
					frame = { kind: "screen" };
				} else if (step.region || step.ref || step.selector) {
					const window = needTarget();
					let region = step.region;
					if (!region) {
						// An element is placed in a screenshot's pixels only once
						// one exists, so one is taken, unseen, if there is none.
						await pixels(driver, step, context.image, signal);
						const resolved = await resolve(driver, step, signal);
						region =
							resolved?.kind === "element" ? resolved.element.frame : undefined;
					} else if (frame?.kind !== "window") {
						throw new Error(
							"A region is in the pixels of a window screenshot: take one first.",
						);
					}
					if (!region) throw new Error("There is nothing there to zoom in on.");
					const output = await driver.call(
						"zoom",
						{
							pid: window.pid,
							window_id: window.windowId,
							x1: region.x,
							y1: region.y,
							x2: region.x + region.width,
							y2: region.y + region.height,
						},
						signal,
					);
					if (output.isError) fail(output);
					shot = toImage(output);
					frame = { kind: "zoom", windowId: window.windowId };
				} else {
					shot = (await read(driver, { screenshot: image, signal })).image;
				}
				if (!shot) throw new Error("The driver returned no image.");
				context.screenshots.push(shot);
				return {
					screenshot: context.screenshots.length,
					...(shot.width ? { width: shot.width, height: shot.height } : {}),
				};
			}

			case "menu": {
				const window = needTarget();
				return await act("invoke_menu", {
					pid: window.pid,
					window_id: window.windowId,
					path: step.path,
				});
			}

			case "clipboard": {
				if (step.text !== undefined) {
					return await act("clipboard_write", { text: step.text });
				}
				const output = await driver.call(
					"clipboard_read",
					{ include_text: true },
					signal,
				);
				if (output.isError) fail(output);
				return {
					text: typeof output.data.text === "string" ? output.data.text : "",
				};
			}

			case "window": {
				const window = needTarget();
				const at = { pid: window.pid, window_id: window.windowId };
				if (step.op === "activate" || step.op === "restore") {
					return await act("bring_to_front", at);
				}
				if (step.op === "move" || step.op === "resize") {
					const [now] = (
						await listWindows(driver, { pid: window.pid }, signal)
					).filter((candidate) => candidate.windowId === window.windowId);
					const bounds = now?.bounds;
					if (!bounds) throw new Error("The window is no longer open.");
					const moved = await act("set_window_frame", {
						...at,
						x: step.x ?? bounds.x,
						y: step.y ?? bounds.y,
						width: step.width ?? bounds.width,
						height: step.height ?? bounds.height,
					});
					frame = undefined;
					return moved;
				}
				// The window's own buttons, pressed where they are: nothing is raised.
				const subroles = {
					minimize: ["AXMinimizeButton"],
					maximize: ["AXZoomButton", "AXFullScreenButton"],
					close: ["AXCloseButton"],
				}[step.op];
				const tree = await current(driver, signal);
				const button = tree.elements.find(
					(element) => !!element.subrole && subroles.includes(element.subrole),
				);
				if (!button) {
					throw new Error(`This window has no ${step.op} button to press.`);
				}
				const result = await act("click", { element_token: button.token });
				if (step.op === "close") {
					target = undefined;
					snapshot = undefined;
					frame = undefined;
				}
				return result;
			}
		}
	};

	// --- status ---------------------------------------------------------------

	const cursorOf = async (
		driver: DriverHandle,
		found: ReturnType<typeof Driver.discover>,
	): Promise<ComputerCursor> => {
		if (options.cursor === false)
			return { available: false, reason: "disabled" };
		if (driver.mode === "app" || driver.mode === "embedded") {
			return { available: true };
		}
		if (driver.mode === "external" || !isMac) {
			const state = await driver.call("get_agent_cursor_state");
			return state.isError
				? { available: false, reason: "unsupported" }
				: { available: true };
		}
		return {
			available: false,
			reason: !found.app
				? "not-installed"
				: !appState.reachable
					? "not-running"
					: "permissions",
		};
	};

	const describeMissing = (missing: string[], owner: string) => {
		const who =
			owner === "app" ? "Cua Driver" : "this app (or the terminal it runs in)";
		if (missing.includes("accessibility")) {
			return `Accessibility access is off: allow ${who} in System Settings › Privacy & Security › Accessibility, then recheck.`;
		}
		if (missing.includes("screen-recording")) {
			return `Screen recording is off, so screenshots are unavailable: allow ${who} in System Settings › Privacy & Security › Screen & System Audio Recording, then recheck.`;
		}
		return undefined;
	};

	const status = async ({ refresh = false } = {}): Promise<ComputerStatus> => {
		if (refresh) await release();
		const os = process.platform;
		const found = Driver.discover(options);
		const app = {
			name: "cua-driver",
			found: !!(found.app ?? found.cli),
			...(found.app || found.cli ? { path: found.app ?? found.cli } : {}),
			...(found.version ? { version: found.version } : {}),
			installable: true,
		};
		const { sdk, error } = await load();
		if (!sdk) {
			return {
				available: false,
				error: `The computer driver could not be loaded on this machine: ${error ?? "unknown error"}`,
				os,
				sdk: { name: "@trycua/cua-driver", found: false },
				app,
				permissions: [],
				missing: [],
				cursor: { available: false, reason: "unsupported" },
			};
		}

		const sdkFound = { name: "@trycua/cua-driver", found: true };
		const host = Driver.hostPermissions(sdk);
		let driver: DriverHandle;
		try {
			driver = await getDriver();
		} catch (failure) {
			return {
				available: false,
				error: errorMessage(failure),
				os,
				sdk: sdkFound,
				app,
				permissions: toPermissions("host", host),
				missing: [],
				cursor: {
					available: false,
					reason: found.app ? "not-running" : "not-installed",
				},
			};
		}

		if (driver.mode === "app") {
			appState.grants = await Driver.permissions(driver);
		}
		const own =
			driver.mode === "app"
				? appState.grants
				: driver.mode === "external"
					? await Driver.permissions(driver)
					: host;
		const owner = driver.mode === "app" ? "app" : "host";
		const permissions = [
			...toPermissions("host", host),
			...toPermissions("app", appState.grants),
		];
		const missing = toPermissions(owner, own)
			.filter((permission) => !permission.granted)
			.map((permission) => permission.name);
		const available = !missing.includes("accessibility");
		const problem = describeMissing(missing, owner);
		return {
			available,
			...(problem ? { error: problem } : {}),
			os,
			mode: driver.mode,
			sdk: sdkFound,
			app,
			permissions,
			missing,
			cursor: await cursorOf(driver, found),
		};
	};

	return {
		status,

		install: async ({
			version,
			...rest
		}: InstallOptions & { version?: string } = {}) => {
			let pinned = version;
			if (!pinned) {
				// The app should be the release this SDK was built against.
				const { sdk } = await load();
				if (sdk) {
					const probe = sdk.CuaDriver.create({
						embedded: true,
						claudeCodeCompatibility: false,
					});
					pinned = await probe
						.metadata()
						.then((metadata) => metadata.driverVersion)
						.catch(() => undefined);
					await probe.shutdown().catch(() => {});
				}
			}
			const result = await Driver.install({
				...rest,
				version: pinned,
				exec: options.exec,
			});
			// Whatever was chosen before is chosen again, now that there is more to choose from.
			if (result.ok) await release();
			return result;
		},

		permissions: async () => (await status()).permissions,

		requestPermissions: async ({ owner = "host", settings = false } = {}) => {
			const sdk = await sdkOrThrow();
			if (owner === "host") {
				Driver.requestHostPermissions(sdk, { settings });
			} else {
				const found = Driver.discover(options);
				const service = await Driver.app({
					sdk,
					app: found.app,
					launch: options.launch ?? true,
				}).catch(() => undefined);
				const asked = await Driver.requestAppPermissions({
					handle: service,
					cli: found.cli,
				});
				await service?.close().catch(() => {});
				if (!asked) {
					throw new Error(
						found.app || found.cli
							? "The Cua Driver app could not be asked for its permissions."
							: "The Cua Driver app is not installed. `install()` downloads it.",
					);
				}
			}
			return (await status({ refresh: true })).permissions;
		},

		windows: async ({ app }: { app?: string } = {}) => {
			const driver = await getDriver();
			return (await listWindows(driver, app ? { app } : {}))
				.filter((window) => (window.bounds?.width ?? 0) > 0)
				.map(publicWindow);
		},

		run: ({ window, steps, screenshot, image, signal }) => {
			const task = async (): Promise<ComputerRunResult> => {
				const driver = await getDriver();
				const screenshots: Image[] = [];
				const context = {
					screenshots,
					image: { ...options.image, ...image },
					signal,
				};
				if (window) setTarget(await findWindow(driver, window, signal));

				const result = await runSteps({
					steps,
					signal,
					execute: (step) => execute(driver, step, context),
				});

				if (screenshot && target && !signal?.aborted) {
					try {
						// What the last step did may still be painting.
						await sleep(SETTLE_MS, signal);
						const { image: shot } = await read(driver, {
							screenshot: context.image,
							signal,
						});
						if (shot) screenshots.push(shot);
					} catch (error) {
						result.steps.push({
							action: "screenshot",
							ok: false,
							error: errorMessage(error),
						});
					}
				}

				return {
					...(target
						? {
								window: {
									id: target.id,
									app: target.app,
									...(target.title ? { title: target.title } : {}),
								},
							}
						: {}),
					steps: result.steps,
					...(result.skipped ? { skipped: result.skipped } : {}),
					screenshots,
				};
			};
			const running = queue.then(task, task);
			queue = running.catch(() => {});
			return running;
		},

		close: async () => {
			target = undefined;
			snapshot = undefined;
			frame = undefined;
			refs.clear();
			await release();
		},
	};
};
