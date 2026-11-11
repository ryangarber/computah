import type {
	InstallOptions,
	InstallResult,
	Permission,
} from "../core/grammar.ts";
import { exec as defaultExec, type Exec, Paths } from "../core/process.ts";
import { errorMessage, runSteps, StepError, sleep } from "../core/run.ts";
import type {
	TerminalCell,
	TerminalMatch,
	TerminalRunResult,
	TerminalScreen,
	TerminalSession,
	TerminalStatus,
	TerminalStep,
} from "./schema.ts";
import { Screen } from "./screen.ts";

const WIDTH = 120;
const HEIGHT = 40;
const POLL_MS = 100;
/** Long enough for a program to read its input and start drawing. */
const SETTLE_MS = 30;
const ESCAPE_MS = 150;

const INFO = [
	"#{session_name}",
	"#{pane_width}",
	"#{pane_height}",
	"#{cursor_x}",
	"#{cursor_y}",
	"#{cursor_flag}",
	"#{pane_dead}",
	"#{pane_dead_status}",
	"#{mouse_sgr_flag}",
	"#{mouse_standard_flag}",
	"#{mouse_button_flag}",
	"#{mouse_any_flag}",
].join("\t");

interface Snapshot {
	session: string;
	width: number;
	height: number;
	cursor?: { row: number; col: number };
	exited?: number;
	mouse: { on: boolean; sgr: boolean; motion: boolean; any: boolean };
	rows: TerminalCell[][];
	/** The number of the first row: 1, or less with scrollback above it. */
	top: number;
	/**
	 * Its text, for telling whether anything changed: a cursor a program blinks
	 * by its own drawing would otherwise never let a screen settle.
	 */
	text: string;
}

/** Steps that do more to a session than look at it. */
const INPUT = new Set([
	"type",
	"press",
	"click",
	"hover",
	"drag",
	"scroll",
	"resize",
	"close",
]);

export interface TerminalOptions {
	/** The tmux to use. Found on PATH and in the usual places otherwise. */
	tmux?: string;
	/**
	 * Runs tmux (and its installer). Pass your own to have sessions live
	 * somewhere this process is not: inside WSL, over SSH, in a sandbox.
	 */
	exec?: Exec;
	/**
	 * A tmux socket name (`tmux -L`), for a server of your own. Without one
	 * the user's default server is used, so they can attach to what is opened
	 * and the agent can look at sessions of theirs.
	 */
	socket?: string;
	/** The user option that marks sessions opened here (default `@computah`). */
	marker?: string;
	/** What unnamed sessions are called, before their number (default `ct`). */
	prefix?: string;
	/** Where `open` runs a command that does not say. */
	cwd?: string | (() => string | undefined | Promise<string | undefined>);
}

export interface Terminal {
	/** What was found to drive terminals with, and whether it is enough. */
	status: (options?: { refresh?: boolean }) => Promise<TerminalStatus>;
	/** Installs tmux with the system's package manager. */
	install: (options?: InstallOptions) => Promise<InstallResult>;
	/** Nothing to grant: driving tmux needs no OS permission. */
	permissions: () => Promise<Permission[]>;
	requestPermissions: () => Promise<Permission[]>;
	/** Runs steps in order, stopping at the first that fails. */
	run: (input: {
		/** The session to act on. Defaults to the last one used. */
		session?: string;
		steps: TerminalStep[];
		/** Capture the target's screen after the steps run. */
		capture?: boolean;
		signal?: AbortSignal;
	}) => Promise<TerminalRunResult>;
	sessions: () => Promise<TerminalSession[]>;
	/**
	 * Whether a run would act on a session that was not opened here — one of
	 * the user's own — with more than looking at it. Worth asking before it.
	 */
	touchesForeign: (input: {
		session?: string;
		steps: TerminalStep[];
	}) => Promise<boolean>;
	/** Forgets the target; with `kill`, also ends every session opened here. */
	close: (options?: { kill?: boolean }) => Promise<void>;
}

/** A step that failed on what was on screen, which is worth showing. */
class ScreenError extends Error {
	readonly snapshot: Snapshot;

	constructor(message: string, snapshot: Snapshot) {
		super(message);
		this.snapshot = snapshot;
	}
}

/** How to install tmux here, by whichever package manager is present. */
const installers: { manager: string; args: string[]; sudo: boolean }[] = [
	{ manager: "brew", args: ["install", "tmux"], sudo: false },
	{ manager: "port", args: ["install", "tmux"], sudo: true },
	{ manager: "apt-get", args: ["install", "-y", "tmux"], sudo: true },
	{ manager: "dnf", args: ["install", "-y", "tmux"], sudo: true },
	{ manager: "yum", args: ["install", "-y", "tmux"], sudo: true },
	{ manager: "pacman", args: ["-S", "--noconfirm", "tmux"], sudo: true },
	{
		manager: "zypper",
		args: ["--non-interactive", "install", "tmux"],
		sudo: true,
	},
	{ manager: "apk", args: ["add", "tmux"], sudo: true },
	{ manager: "nix-env", args: ["-iA", "nixpkgs.tmux"], sudo: false },
];

export const createTerminal = (options: TerminalOptions = {}): Terminal => {
	const run = options.exec ?? defaultExec;
	const marker = options.marker ?? "@computah";
	const prefix = options.prefix ?? "ct";
	const buffer = marker.replace(/\W/g, "") || "computah";
	/** A custom runner finds programs its own way, so only a name is given it. */
	const local = !options.exec;

	let program: Promise<string | undefined> | undefined;
	let target: string | undefined;

	const SESSION = [
		"#{session_name}",
		"#{window_width}",
		"#{window_height}",
		"#{session_attached}",
		`#{${marker}}`,
		"#{pane_current_command}",
		"#{pane_dead}",
		"#{pane_dead_status}",
	].join("\t");

	const find = () => {
		program ??= (async () => {
			if (options.tmux) return options.tmux;
			if (local) return Paths.which("tmux", Paths.common());
			const { code } = await run({ program: "tmux", args: ["-V"] });
			return code === 0 ? "tmux" : undefined;
		})();
		return program;
	};

	const cwd = async () =>
		typeof options.cwd === "function" ? await options.cwd() : options.cwd;

	const tmux = async (args: string[], signal?: AbortSignal) => {
		const path = await find();
		if (!path) throw new Error("tmux is not installed.");
		const result = await run({
			program: path,
			args: [...(options.socket ? ["-L", options.socket] : []), ...args],
			signal,
		});
		if (result.code) {
			throw new Error(
				result.stderr.trim() ||
					result.stdout.trim() ||
					`tmux exited with status ${result.code}`,
			);
		}
		return result.stdout;
	};

	/** A session as a target: `=` so `ct-1` never means `ct-10`. */
	const session = (name: string) => `=${name}`;
	/** Its active pane. */
	const pane = (name: string) => `=${name}:`;
	const attach = (name: string) =>
		`tmux ${options.socket ? `-L ${options.socket} ` : ""}attach -t ${name}`;

	const sessions = async (signal?: AbortSignal): Promise<TerminalSession[]> => {
		let out: string;
		try {
			out = await tmux(["list-sessions", "-F", SESSION], signal);
		} catch (error) {
			if (
				/no server running|error connecting|no sessions|No such file/i.test(
					errorMessage(error),
				)
			)
				return [];
			throw error;
		}
		return out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [
					name = "",
					width,
					height,
					attached,
					opened,
					command,
					dead,
					status,
				] = line.split("\t");
				return {
					name,
					width: Number(width),
					height: Number(height),
					...(command ? { command } : {}),
					...(dead === "1" ? { exited: Number(status) || 0 } : {}),
					...(Number(attached) ? { attached: true } : {}),
					...(opened === "1" ? { opened: true } : {}),
					attach: attach(name),
				};
			});
	};

	const snapshot = async (
		name: string,
		signal?: AbortSignal,
		history = 0,
	): Promise<Snapshot> => {
		const out = await tmux(
			[
				"display-message",
				"-p",
				"-t",
				pane(name),
				INFO,
				";",
				"capture-pane",
				"-p",
				"-e",
				"-N",
				"-t",
				pane(name),
				...(history ? ["-S", `-${history}`] : []),
			],
			signal,
		);
		const newline = out.indexOf("\n");
		const [
			sessionName = name,
			width,
			height,
			x,
			y,
			cursor,
			dead,
			status,
			sgr,
			standard,
			button,
			any,
		] = out.slice(0, newline).split("\t");
		const rows = Screen.parse(out.slice(newline + 1));
		const h = Number(height);
		// The screen is always its full height, so whatever is past it is scrollback.
		while (rows.length < h) rows.push([]);
		return {
			session: sessionName,
			width: Number(width),
			height: h,
			...(cursor === "1"
				? { cursor: { row: Number(y) + 1, col: Number(x) + 1 } }
				: {}),
			...(dead === "1" ? { exited: Number(status) || 0 } : {}),
			mouse: {
				on: [standard, button, any].includes("1"),
				sgr: sgr === "1",
				motion: button === "1" || any === "1",
				any: any === "1",
			},
			rows,
			top: 1 - (rows.length - h),
			text: rows.map(Screen.text).join("\n"),
		};
	};

	/** Adds a screen to the result, returning its number (from 1). */
	const addScreen = (
		screens: TerminalScreen[],
		snap: Snapshot,
		{ top, bottom, at }: { top?: number; bottom?: number; at?: number } = {},
	) => {
		const first = Math.max(top ?? snap.top, snap.top);
		const rows = snap.rows.slice(
			first - snap.top,
			bottom === undefined ? undefined : bottom - snap.top + 1,
		);
		const lines = rows.map(Screen.text);
		while (lines.length && !lines.at(-1)) lines.pop();
		screens.push({
			session: snap.session,
			width: snap.width,
			height: snap.height,
			...(snap.cursor ? { cursor: snap.cursor } : {}),
			top: first,
			...(at === undefined ? {} : { at }),
			lines,
		});
		return screens.length;
	};

	/** A live snapshot of the target, for steps that give it input. */
	const live = async (name: string, signal?: AbortSignal) => {
		const snap = await snapshot(name, signal);
		if (snap.exited !== undefined)
			throw new ScreenError(
				`The program has exited (status ${snap.exited}). Open it again to restart it.`,
				snap,
			);
		return snap;
	};

	/** Where a match is on screen: the middle of the first one, or the cell it names. */
	const locate = (snap: Snapshot, match: TerminalMatch) => {
		if (!Screen.isMatch(match))
			throw new Error(
				"Say where: a `selector`, `text` or `regex` to find, or a `row` and `col`.",
			);
		const [found] = Screen.find(snap.rows, match, snap.top);
		if (!found)
			throw new ScreenError(
				`Nothing on screen matches ${Screen.describe(match)}.`,
				snap,
			);
		return {
			row: found.row,
			col: found.col + Math.floor((found.width - 1) / 2),
		};
	};

	const mouse = (snap: Snapshot) => {
		if (!snap.mouse.on)
			throw new ScreenError(
				"The program is not reading the mouse: it has not turned mouse reporting on.",
				snap,
			);
		return snap.mouse;
	};

	const nextName = async (signal?: AbortSignal) => {
		const taken = new Set((await sessions(signal)).map((s) => s.name));
		let n = 1;
		while (taken.has(`${prefix}-${n}`)) n++;
		return `${prefix}-${n}`;
	};

	const execute = async (
		step: TerminalStep,
		screens: TerminalScreen[],
		signal?: AbortSignal,
	): Promise<unknown> => {
		const started = Date.now();
		const elapsed = () => Date.now() - started;

		if (step.action === "sessions") return await sessions(signal);

		if (step.action === "open") {
			const name = step.name ?? (await nextName(signal));
			if (!/^[\w-]+$/.test(name))
				throw new Error("Session names are letters, digits, `-` and `_`.");
			const existing = (await sessions(signal)).find((s) => s.name === name);
			if (existing && !existing.opened)
				throw new Error(
					`"${name}" is a session that was not opened here, so it is left alone. Pick another name.`,
				);
			if (existing) await tmux(["kill-session", "-t", session(name)], signal);

			const width = String(step.width ?? WIDTH);
			const height = String(step.height ?? HEIGHT);
			const dir = step.cwd ?? (await cwd());
			const at = dir ? ["-c", dir] : [];
			const env = Object.entries({
				COLORTERM: "truecolor",
				...step.env,
			}).flatMap(([key, value]) => ["-e", Screen.arg(`${key}=${value}`)]);
			// The program starts once the pane is set to outlive it, so even one
			// that exits at once leaves its screen and status to read.
			const created = tmux(
				[
					"new-session",
					"-d",
					"-s",
					name,
					"-x",
					width,
					"-y",
					height,
					...at,
					";",
					"set-option",
					"-t",
					pane(name),
					marker,
					"1",
					";",
					"set-option",
					"-w",
					"-t",
					pane(name),
					"remain-on-exit",
					"on",
					";",
					// tmux's own "Pane is dead" line scrolls the last screen away.
					"set-option",
					"-q",
					"-w",
					"-t",
					pane(name),
					"remain-on-exit-format",
					"",
					";",
					"resize-window",
					"-t",
					pane(name),
					"-x",
					width,
					"-y",
					height,
					";",
					"respawn-pane",
					"-k",
					"-t",
					pane(name),
					...at,
					...env,
					Screen.arg(step.command),
				],
				signal,
			);
			// Half set up, it would pass for one of the user's own sessions.
			await created.catch(async (error) => {
				await tmux(["kill-session", "-t", session(name)]).catch(() => {});
				throw error;
			});
			target = name;
			return { session: name, attach: attach(name) };
		}

		if (!target) {
			const opened = (await sessions(signal)).filter((s) => s.opened);
			const [only] = opened;
			if (opened.length !== 1 || !only)
				throw new Error(
					"There is no session to act on: open one, or name one with `session`.",
				);
			target = only.name;
		}
		const name = target;
		const send = (bytes: number[]) =>
			tmux(
				[
					"send-keys",
					"-t",
					pane(name),
					"-H",
					...bytes.map((b) => b.toString(16).padStart(2, "0")),
				],
				signal,
			);

		switch (step.action) {
			case "close": {
				await tmux(["kill-session", "-t", session(name)], signal);
				target = undefined;
				return undefined;
			}

			case "resize": {
				await tmux(
					[
						"resize-window",
						"-t",
						pane(name),
						...(step.width ? ["-x", String(step.width)] : []),
						...(step.height ? ["-y", String(step.height)] : []),
					],
					signal,
				);
				await sleep(SETTLE_MS, signal);
				return undefined;
			}

			case "type": {
				await live(name, signal);
				if (step.paste) {
					await tmux(
						[
							"set-buffer",
							"-b",
							buffer,
							"--",
							Screen.arg(step.text),
							";",
							"paste-buffer",
							"-p",
							"-d",
							"-b",
							buffer,
							"-t",
							pane(name),
						],
						signal,
					);
				} else if (step.text) {
					await tmux(
						["send-keys", "-t", pane(name), "-l", "--", Screen.arg(step.text)],
						signal,
					);
				}
				if (step.submit) {
					await tmux(["send-keys", "-t", pane(name), "Enter"], signal);
				}
				await sleep(SETTLE_MS, signal);
				return undefined;
			}

			case "press": {
				await live(name, signal);
				const keys = step.keys.split(/\s+/).filter(Boolean).map(Screen.key);
				if (!keys.length) throw new Error("No keys to press.");
				const all = Array.from({ length: step.count ?? 1 }, () => keys).flat();
				await tmux(["send-keys", "-t", pane(name), ...all], signal);
				// A program cannot tell Escape from the start of the next key's
				// sequence until it has waited a moment for one.
				await sleep(all.at(-1) === "Escape" ? ESCAPE_MS : SETTLE_MS, signal);
				return undefined;
			}

			case "click": {
				const snap = await live(name, signal);
				const { sgr } = mouse(snap);
				const at = locate(snap, Screen.match(step));
				const button = { left: 0, middle: 1, right: 2 }[step.button ?? "left"];
				for (let i = 0; i < (step.count ?? 1); i++) {
					for (const release of [false, true])
						await send(
							Screen.mouse({
								sgr,
								button,
								...at,
								release,
								modifiers: step.modifiers,
							}),
						);
				}
				await sleep(SETTLE_MS, signal);
				return at;
			}

			case "hover": {
				const snap = await live(name, signal);
				const { sgr, any } = mouse(snap);
				if (!any)
					throw new ScreenError(
						"The program does not track the mouse while no button is down, so it cannot be hovered over.",
						snap,
					);
				const at = locate(snap, Screen.match(step));
				await send(Screen.mouse({ sgr, button: 3, ...at, motion: true }));
				await sleep(SETTLE_MS, signal);
				return at;
			}

			case "drag": {
				const snap = await live(name, signal);
				const { sgr, motion } = mouse(snap);
				const from = locate(snap, Screen.match(step));
				const to = locate(snap, Screen.match(step.to));
				const button = { left: 0, middle: 1, right: 2 }[step.button ?? "left"];
				const event = (
					point: { row: number; col: number },
					kind: { release?: boolean; motion?: boolean } = {},
				) =>
					send(
						Screen.mouse({
							sgr,
							button,
							...point,
							...kind,
							modifiers: step.modifiers,
						}),
					);
				await event(from);
				if (motion) {
					const count = Math.min(
						12,
						Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col)),
					);
					for (let i = 1; i <= count; i++) {
						await sleep(10, signal);
						await event(
							{
								row: Math.round(from.row + ((to.row - from.row) * i) / count),
								col: Math.round(from.col + ((to.col - from.col) * i) / count),
							},
							{ motion: true },
						);
					}
				}
				await event(to, { release: true });
				await sleep(SETTLE_MS, signal);
				return { from, to };
			}

			case "scroll": {
				const snap = await live(name, signal);
				const { sgr } = mouse(snap);
				const match = Screen.match(step);
				const at = Screen.isMatch(match)
					? locate(snap, match)
					: {
							row: Math.ceil(snap.height / 2),
							col: Math.ceil(snap.width / 2),
						};
				const dy = step.dy ?? (step.dx ? 0 : 3);
				const dx = step.dx ?? 0;
				const notches = [
					...Array<number>(Math.abs(dy)).fill(dy < 0 ? 64 : 65),
					...Array<number>(Math.abs(dx)).fill(dx < 0 ? 66 : 67),
				];
				await send(
					notches.flatMap((button) => Screen.mouse({ sgr, button, ...at })),
				);
				await sleep(SETTLE_MS, signal);
				return at;
			}

			case "expect": {
				const snap = await snapshot(name, signal);
				const match = Screen.match(step);
				if (!Screen.isMatch(match))
					throw new Error(
						"Say what to expect: a `selector`, `text`, `regex`, or a cell's style.",
					);
				const found = Screen.find(snap.rows, match, snap.top);
				const [first] = found;
				if (step.gone ? first : !first)
					throw new ScreenError(
						first
							? `${Screen.describe(match)} is on screen (row ${first.row}, column ${first.col}).`
							: `Nothing on screen matches ${Screen.describe(match)}.`,
						snap,
					);
				return step.gone ? undefined : { ...first, count: found.length };
			}

			case "wait": {
				const match = Screen.match(step);
				const matching = Screen.isMatch(match);
				if (!matching && !step.stable && !step.exit) {
					await sleep(Math.min(step.ms ?? 1000, 60_000), signal);
					return { elapsed: elapsed() };
				}
				const timeout = Math.min(step.timeout ?? 10_000, 120_000);
				let last: string | undefined;
				let changed = Date.now();
				for (;;) {
					const snap = await snapshot(name, signal);
					if (snap.text !== last) {
						last = snap.text;
						changed = Date.now();
					}
					if (step.exit) {
						if (snap.exited !== undefined)
							return { exited: snap.exited, elapsed: elapsed() };
					} else if (snap.exited !== undefined) {
						throw new ScreenError(
							`The program exited (status ${snap.exited}) while waiting.`,
							snap,
						);
					}
					const settled = !step.stable || Date.now() - changed >= step.stable;
					if (!step.exit && matching) {
						const [found] = Screen.find(snap.rows, match, snap.top);
						if (settled && (step.gone ? !found : found))
							return step.gone
								? { elapsed: elapsed() }
								: { ...found, elapsed: elapsed() };
					} else if (!step.exit && settled) {
						return { elapsed: elapsed() };
					}
					if (elapsed() >= timeout) {
						const what = step.exit
							? "the program to exit"
							: matching
								? `${Screen.describe(match)} to ${step.gone ? "go" : "appear"}`
								: `the screen to settle for ${step.stable}ms`;
						throw new ScreenError(
							`Timed out after ${timeout}ms waiting for ${what}.`,
							snap,
						);
					}
					await sleep(POLL_MS, signal);
				}
			}

			case "capture": {
				const frames = step.frames ?? 1;
				const numbers: number[] = [];
				let last: string | undefined;
				let snap: Snapshot | undefined;
				for (let i = 0; i < frames; i++) {
					if (i) await sleep(step.interval ?? 250, signal);
					snap = await snapshot(name, signal, step.history);
					const key = `${snap.text}\n${JSON.stringify(snap.cursor)}`;
					if (key === last) continue;
					last = key;
					numbers.push(
						addScreen(screens, snap, {
							top: step.top,
							bottom: step.bottom,
							...(frames > 1 ? { at: elapsed() } : {}),
						}),
					);
				}
				const first = snap ? Math.max(step.top ?? snap.top, snap.top) : 1;
				const styles =
					step.styles && snap
						? Screen.styles(
								snap.rows.slice(
									first - snap.top,
									step.bottom === undefined
										? undefined
										: step.bottom - snap.top + 1,
								),
								first,
							)
						: undefined;
				return {
					...(numbers.length === 1
						? { screen: numbers[0] }
						: { screens: numbers }),
					...(styles ? { styles } : {}),
				};
			}
		}
	};

	const status = async ({ refresh = false } = {}): Promise<TerminalStatus> => {
		if (refresh) program = undefined;
		const path = await find().catch(() => undefined);
		const installable =
			process.platform !== "win32" || !local
				? installers.some(
						({ manager }) => !local || Paths.which(manager, Paths.common()),
					)
				: false;
		if (!path) {
			return {
				available: false,
				error:
					process.platform === "win32" && local
						? "tmux does not run on Windows itself. Run it inside WSL by passing an `exec` that runs programs there."
						: "tmux was not found. Install it to drive terminal programs, then recheck.",
				tmux: { name: "tmux", found: false, installable },
				permissions: [],
			};
		}
		const { code, stdout, stderr } = await run({
			program: path,
			args: ["-V"],
		}).catch((error) => ({ code: -1, stdout: "", stderr: String(error) }));
		const version = /(\d[\w.]*)/.exec(stdout)?.[1];
		return {
			available: code === 0,
			...(code === 0
				? {}
				: {
						error: `tmux could not be run: ${stderr.trim() || `status ${code}`}`,
					}),
			tmux: {
				name: "tmux",
				found: code === 0,
				path,
				...(version ? { version } : {}),
				source: options.tmux ? "option" : "system",
				installable,
			},
			permissions: [],
		};
	};

	return {
		status,

		install: async ({ signal, onProgress }: InstallOptions = {}) => {
			if ((await status({ refresh: true })).available) {
				return { ok: true, installed: [] };
			}
			for (const { manager, args, sudo } of installers) {
				const found = local ? Paths.which(manager, Paths.common()) : manager;
				if (!found) continue;
				if (!local) {
					const probe = await run({ program: manager, args: ["--version"] });
					if (probe.code !== 0) continue;
				}
				const root = !sudo || process.getuid?.() === 0;
				// Never prompts for a password: with none cached, the command to
				// run is handed back instead.
				const [installer, installerArgs] = root
					? [found, args]
					: ["sudo", ["-n", found, ...args]];
				const command = `${sudo ? "sudo " : ""}${manager} ${args.join(" ")}`;
				onProgress?.({ phase: "install", message: `Running ${command}` });
				const result = await run({
					program: installer,
					args: installerArgs,
					signal,
					onOutput: (chunk) =>
						onProgress?.({ phase: "install", message: chunk.trimEnd() }),
				});
				const output = `${result.stdout}${result.stderr}`.trim().slice(-4_000);
				if (result.code === 0 && (await status({ refresh: true })).available) {
					return { ok: true, installed: ["tmux"], command, output };
				}
				return {
					ok: false,
					installed: [],
					error:
						sudo && !root
							? "Installing tmux needs administrator rights. Run the command yourself, then recheck."
							: `${manager} could not install tmux.`,
					command,
					output,
				};
			}
			return {
				ok: false,
				installed: [],
				error:
					"No package manager was found to install tmux with. Install it yourself, then recheck.",
			};
		},

		permissions: async () => [],
		requestPermissions: async () => [],

		sessions: () => sessions(),

		touchesForeign: async ({ session: name, steps }) => {
			const acted = name ?? target;
			const before = steps.findIndex((step) => step.action === "open");
			const acts = steps
				.slice(0, before < 0 ? undefined : before)
				.some((step) => INPUT.has(step.action));
			if (!acted || !acts) return false;
			const found = (await sessions()).find((s) => s.name === acted);
			return !!found && !found.opened;
		},

		run: async ({ session: name, steps, capture, signal }) => {
			if (name) target = name;
			const screens: TerminalScreen[] = [];
			const started = Date.now();

			const result = await runSteps({
				steps,
				signal,
				execute: async (step) => {
					try {
						return await execute(step, screens, signal);
					} catch (error) {
						if (!(error instanceof ScreenError)) throw error;
						// The screen it gave up on says more than the message does.
						throw new StepError(error.message, {
							screen: addScreen(screens, error.snapshot, {
								at: Date.now() - started,
							}),
						});
					}
				},
			});

			if (capture && target && !signal?.aborted) {
				try {
					addScreen(screens, await snapshot(target, signal));
				} catch (error) {
					result.steps.push({
						action: "capture",
						ok: false,
						error: errorMessage(error),
					});
				}
			}

			let current: TerminalSession | undefined;
			if (target && !signal?.aborted) {
				const acted = target;
				current = (await sessions().catch(() => [])).find(
					(s) => s.name === acted,
				);
			}

			return {
				...(current ? { session: current } : {}),
				steps: result.steps,
				...(result.skipped ? { skipped: result.skipped } : {}),
				screens,
			};
		},

		close: async ({ kill = false } = {}) => {
			target = undefined;
			if (!kill) return;
			for (const opened of await sessions().catch(() => [])) {
				if (!opened.opened) continue;
				await tmux(["kill-session", "-t", session(opened.name)]).catch(
					() => {},
				);
			}
		},
	};
};
