import type { Modifier } from "./grammar.ts";

/** One key press: a key with the modifiers held around it. */
export interface Chord {
	/** As written, without its modifiers: `Enter`, `a`, `F5`, `+`. */
	key: string;
	/** In a fixed order, without repeats, `Mod` resolved. */
	modifiers: Exclude<Modifier, "Mod">[];
}

const MODIFIERS: Record<string, Modifier> = {
	alt: "Alt",
	option: "Alt",
	opt: "Alt",
	control: "Control",
	ctrl: "Control",
	ctl: "Control",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta",
	super: "Meta",
	win: "Meta",
	shift: "Shift",
	mod: "Mod",
	controlormeta: "Mod",
	commandorcontrol: "Mod",
	cmdorctrl: "Mod",
};

const ORDER = ["Control", "Alt", "Shift", "Meta"] as const;

/** Names for the same key, lowercased, to the one name used here. */
const KEYS: Record<string, string> = {
	enter: "Enter",
	return: "Enter",
	tab: "Tab",
	escape: "Escape",
	esc: "Escape",
	backspace: "Backspace",
	delete: "Delete",
	del: "Delete",
	insert: "Insert",
	ins: "Insert",
	space: "Space",
	spacebar: "Space",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pgup: "PageUp",
	pagedown: "PageDown",
	pgdn: "PageDown",
};

const isMac = (platform: string) =>
	platform === "darwin" || platform === "macos";

export const Keys = {
	/** A modifier by any of its names, or undefined for anything else. */
	modifier: (name: string): Modifier | undefined =>
		MODIFIERS[name.toLowerCase()],

	/** `Mod` as the platform has it; every other modifier as it is. */
	resolve: (
		modifier: Modifier,
		platform: string = process.platform,
	): Exclude<Modifier, "Mod"> =>
		modifier === "Mod" ? (isMac(platform) ? "Meta" : "Control") : modifier,

	/** Modifiers by any of their names, resolved, ordered and without repeats. */
	modifiers: (
		names: readonly string[] = [],
		platform: string = process.platform,
	): Exclude<Modifier, "Mod">[] => {
		const held = new Set(
			names.map((name) => {
				const modifier = Keys.modifier(name);
				if (!modifier) throw new Error(`Unknown modifier "${name}"`);
				return Keys.resolve(modifier, platform);
			}),
		);
		return ORDER.filter((modifier) => held.has(modifier));
	},

	/**
	 * One token of a `keys` string: `Enter`, `Control+A`, `Shift+Tab`,
	 * `Control++` (Control and the plus key). Named keys are spelled the
	 * Playwright way whatever way they came in (`esc` → `Escape`); anything
	 * else is kept as written, so `a` and `A` stay different keys.
	 */
	chord: (token: string, platform: string = process.platform): Chord => {
		const parts =
			token === "+"
				? ["+"]
				: token.endsWith("++")
					? [...token.slice(0, -2).split("+"), "+"]
					: token.split("+");
		const name = parts.pop() ?? "";
		if (!name) throw new Error(`No key in "${token}"`);
		const modifiers = Keys.modifiers(
			parts.map((part) => {
				if (!Keys.modifier(part)) {
					throw new Error(`Unknown modifier "${part}" in "${token}"`);
				}
				return part;
			}),
			platform,
		);
		const lower = name.toLowerCase();
		const key =
			KEYS[lower] ??
			(/^f([1-9]|1\d|2[0-4])$/.test(lower) ? lower.toUpperCase() : name);
		return { key, modifiers };
	},

	/** Every chord of a `keys` string: `"Control+A Backspace"` is two. */
	parse: (keys: string, platform: string = process.platform): Chord[] => {
		const chords = keys
			.split(/\s+/)
			.filter(Boolean)
			.map((token) => Keys.chord(token, platform));
		if (!chords.length) throw new Error("No keys to press.");
		return chords;
	},

	/** A chord as Playwright's `keyboard.press` takes it. */
	format: ({ key, modifiers }: Chord) => [...modifiers, key].join("+"),
} as const;
