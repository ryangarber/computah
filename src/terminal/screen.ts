import { Keys } from "../core/keys.ts";
import { Selector } from "../core/selector.ts";
import {
	type TerminalCell,
	type TerminalMatch,
	type TerminalStyle,
	zTerminalMatch,
} from "./schema.ts";

const NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
] as const;

const hex = (r: number, g: number, b: number) =>
	`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const named = (n: number) => NAMES[n] ?? "default";

/** A palette index as matches name it: the first 16 by name, the rest as xterm draws them. */
const indexed = (n: number) => {
	if (n < 8) return named(n);
	if (n < 16) return `bright${named(n - 8)}`;
	if (n < 232) {
		const level = (v: number) => (v ? 55 + v * 40 : 0);
		const i = n - 16;
		return hex(
			level(Math.floor(i / 36)),
			level(Math.floor(i / 6) % 6),
			level(i % 6),
		);
	}
	const v = 8 + (n - 232) * 10;
	return hex(v, v, v);
};

const DEFAULT_STYLE: TerminalStyle = {
	fg: "default",
	bg: "default",
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	inverse: false,
};

const BLANK: TerminalCell = { ...DEFAULT_STYLE, char: " " };

/** Reads `38;5;n` or `38;2;r;g;b` from `params` at `i`, saying how many it used. */
const extended = (
	params: number[],
	i: number,
): [string | undefined, number] => {
	if (params[i + 1] === 5) return [indexed(params[i + 2] ?? 0), 3];
	if (params[i + 1] === 2)
		return [hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0), 5];
	return [undefined, 1];
};

const applySgr = (style: TerminalStyle, raw: string): TerminalStyle => {
	const next = { ...style };
	const params =
		raw === "" ? [0] : raw.split(/[;:]/).map((p) => Number(p) || 0);
	for (let i = 0; i < params.length; ) {
		const p = params[i] ?? 0;
		if (p === 38 || p === 48 || p === 58) {
			const [color, used] = extended(params, i);
			if (color && p === 38) next.fg = color;
			if (color && p === 48) next.bg = color;
			i += used;
			continue;
		}
		if (p === 0) Object.assign(next, DEFAULT_STYLE);
		else if (p === 1) next.bold = true;
		else if (p === 2) next.dim = true;
		else if (p === 3) next.italic = true;
		else if (p === 4) next.underline = true;
		else if (p === 7) next.inverse = true;
		else if (p === 21) next.underline = true;
		else if (p === 22) next.bold = next.dim = false;
		else if (p === 23) next.italic = false;
		else if (p === 24) next.underline = false;
		else if (p === 27) next.inverse = false;
		else if (p >= 30 && p <= 37) next.fg = named(p - 30);
		else if (p === 39) next.fg = "default";
		else if (p >= 40 && p <= 47) next.bg = named(p - 40);
		else if (p === 49) next.bg = "default";
		else if (p >= 90 && p <= 97) next.fg = `bright${named(p - 90)}`;
		else if (p >= 100 && p <= 107) next.bg = `bright${named(p - 100)}`;
		i++;
	}
	return next;
};

/** Columns a code point takes: 0 for marks and joiners, 2 for wide ones. */
const widthOf = (char: string) => {
	const cp = char.codePointAt(0) ?? 0;
	if (
		cp < 0x20 ||
		/\p{M}/u.test(char) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		cp === 0x2060 ||
		(cp >= 0xfe00 && cp <= 0xfe0f)
	)
		return 0;
	if (
		/\p{Emoji_Presentation}/u.test(char) ||
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
		return 2;
	return 1;
};

const blank = (cell: TerminalCell) => !cell.char.trim();

/** `Bright Red`, `bright-red` and `#FF0000` as cells spell them. */
const normalizeColor = (color: string) => {
	const value = color.trim().toLowerCase();
	if (/^#[0-9a-f]{3}$/.test(value))
		return `#${[...value.slice(1)].map((c) => c + c).join("")}`;
	return value.replace(/[\s_-]/g, "");
};

const STYLE_KEYS = [
	"fg",
	"bg",
	"bold",
	"dim",
	"italic",
	"underline",
	"inverse",
] as const;
type StyleKey = (typeof STYLE_KEYS)[number];
const FLAGS = ["bold", "dim", "italic", "underline", "inverse"] as const;

/** A match with its selector folded in and its text made a pattern. */
export interface TerminalQuery {
	pattern?: RegExp;
	/** How the pattern was asked for, for messages. */
	label?: string;
	row?: number;
	col?: number;
	style: Partial<TerminalStyle>;
	/** Which match to take, from 0; negative counts from the last. */
	nth?: number;
}

/** Whether a cell looks as the query asks; blank cells only answer for their background. */
const styled = (cell: TerminalCell, style: Partial<TerminalStyle>) => {
	const check = (key: StyleKey) => {
		const wanted = style[key];
		if (wanted === undefined) return true;
		return typeof wanted === "string"
			? normalizeColor(wanted) === cell[key]
			: wanted === cell[key];
	};
	if (!check("bg") || !check("inverse")) return false;
	if (blank(cell)) return true;
	return (["fg", "bold", "dim", "italic", "underline"] as const).every(check);
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const global = (pattern: RegExp) =>
	new RegExp(pattern.source, [...new Set(`${pattern.flags}gu`)].join(""));

/** A selector as the fields of a query. */
const fromSelector = (selector: string): TerminalQuery => {
	const query: TerminalQuery = { style: {} };
	for (const part of Selector.parse(selector)) {
		if (part.engine === "nth") {
			query.nth = part.index;
			continue;
		}
		if (part.engine === "role" || part.engine === "id") {
			throw new Error(
				`A terminal has no ${part.engine}s to select by: use text, a /pattern/, or [fg=…], [bg=…], [bold], [row=…], [col=…].`,
			);
		}
		if (part.value) {
			if (query.pattern) {
				throw new Error("A terminal selector takes one text or pattern.");
			}
			const value = part.value;
			query.label = Selector.describe(value);
			query.pattern =
				value.kind === "regex"
					? global(value.pattern)
					: new RegExp(
							literal(value.text),
							value.kind === "exact" ? "gu" : "giu",
						);
		}
		for (const attribute of part.attributes) {
			const text =
				attribute.value?.kind === "regex" ? undefined : attribute.value?.text;
			const name = attribute.name;
			if (name === "row" || name === "col") {
				const n = Number(text);
				if (!Number.isInteger(n) || n < 1) {
					throw new Error(`[${name}=…] takes a number from 1.`);
				}
				query[name] = n;
			} else if (name === "fg" || name === "bg") {
				if (!text) throw new Error(`[${name}=…] takes a color.`);
				query.style[name] = text;
			} else if ((FLAGS as readonly string[]).includes(name)) {
				query.style[name as (typeof FLAGS)[number]] = text !== "false";
			} else {
				throw new Error(
					`A terminal cell has no "${name}": use fg, bg, bold, dim, italic, underline, inverse, row or col.`,
				);
			}
		}
	}
	return query;
};

export interface TerminalFound {
	row: number;
	col: number;
	/** Columns it spans. */
	width: number;
	text: string;
}

export const Screen = {
	/**
	 * Cells from `capture-pane -e` output: one row per line, styled by its SGR
	 * sequences, with other escapes (hyperlinks, say) dropped. A wide character
	 * is followed by an empty cell, so columns line up with the screen's.
	 */
	parse: (captured: string): TerminalCell[][] => {
		const rows: TerminalCell[][] = [];
		let style = { ...DEFAULT_STYLE };
		const pattern =
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
			/\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|([^\x1b])/gsu;
		const lines = captured.replace(/\n$/, "").split("\n");
		for (const line of lines) {
			const row: TerminalCell[] = [];
			for (const [, params, final, char] of line.matchAll(pattern)) {
				if (final === "m") style = applySgr(style, params ?? "");
				if (char === undefined || char === "\r") continue;
				const width = widthOf(char);
				const last = row.at(-1);
				if (width === 0) {
					if (last) last.char += char;
					continue;
				}
				row.push({ ...style, char });
				if (width === 2) row.push({ ...style, char: "" });
			}
			rows.push(row);
		}
		return rows;
	},

	/** A row's text, trailing blanks trimmed. */
	text: (row: TerminalCell[]) =>
		row
			.map((cell) => cell.char)
			.join("")
			.trimEnd(),

	/** The match a step describes, out of everything else it says. */
	match: (step: TerminalMatch): TerminalMatch =>
		Object.fromEntries(
			(Object.keys(zTerminalMatch) as (keyof TerminalMatch)[])
				.filter((key) => step[key] !== undefined)
				.map((key) => [key, step[key]]),
		),

	/** Whether the match says what to look for, rather than nothing at all. */
	isMatch: (match: TerminalMatch) =>
		(Object.keys(zTerminalMatch) as (keyof TerminalMatch)[]).some(
			(key) => match[key] !== undefined,
		),

	/**
	 * A match as one query: its selector first, then the fields beside it,
	 * which win where both say something.
	 */
	query: (match: TerminalMatch): TerminalQuery => {
		const query: TerminalQuery = match.selector
			? fromSelector(match.selector)
			: { style: {} };
		if (match.regex !== undefined) {
			query.pattern = new RegExp(match.regex, "gu");
			query.label = `/${match.regex}/`;
		} else if (match.text !== undefined) {
			query.pattern = new RegExp(literal(match.text), "gu");
			query.label = JSON.stringify(match.text);
		}
		if (match.row !== undefined) query.row = match.row;
		if (match.col !== undefined) query.col = match.col;
		for (const key of STYLE_KEYS) {
			const value = match[key];
			if (value !== undefined) Object.assign(query.style, { [key]: value });
		}
		return query;
	},

	/**
	 * Everything on screen the match describes, top to bottom. Rows are
	 * numbered from `top` (1 unless scrollback is included above).
	 */
	find: (
		rows: TerminalCell[][],
		match: TerminalMatch,
		top = 1,
	): TerminalFound[] => {
		const query = Screen.query(match);
		const found: TerminalFound[] = [];
		const { pattern, style } = query;

		for (const [index, cells] of rows.entries()) {
			const row = top + index;
			if (query.row !== undefined && query.row !== row) continue;

			if (!pattern) {
				// A cell by its place, or each run of cells in the style asked for.
				if (query.col !== undefined) {
					const cell = cells[query.col - 1] ?? BLANK;
					if (styled(cell, style))
						found.push({ row, col: query.col, width: 1, text: cell.char });
					continue;
				}
				let start = -1;
				for (let i = 0; i <= cells.length; i++) {
					const cell = cells[i];
					const ok = !!cell && styled(cell, style);
					if (ok && start < 0 && cell && !blank(cell)) start = i;
					if (!ok && start >= 0) {
						let end = i;
						while (end > start && blank(cells[end - 1] ?? BLANK)) end--;
						found.push({
							row,
							col: start + 1,
							width: end - start,
							text: cells
								.slice(start, end)
								.map((c) => c.char)
								.join(""),
						});
						start = -1;
					}
				}
				continue;
			}

			// Each character of the text, by the column it starts in.
			let text = "";
			const columns: number[] = [];
			for (const [col, cell] of cells.entries()) {
				for (let i = 0; i < cell.char.length; i++) columns.push(col);
				text += cell.char;
			}
			columns.push(cells.length);

			pattern.lastIndex = 0;
			for (const result of text.matchAll(pattern)) {
				if (!result[0]) continue;
				const start = columns[result.index] ?? 0;
				const end = columns[result.index + result[0].length] ?? cells.length;
				if (query.col !== undefined && query.col !== start + 1) continue;
				if (!cells.slice(start, end).every((cell) => styled(cell, style)))
					continue;
				found.push({
					row,
					col: start + 1,
					width: Math.max(1, end - start),
					text: result[0],
				});
			}
		}

		if (query.nth === undefined) return found;
		const one = found.at(query.nth);
		return one ? [one] : [];
	},

	/** `"Ready" (fg red) on row 3`, for errors. */
	describe: (match: TerminalMatch) => {
		const query = Screen.query(match);
		const what =
			query.label ??
			(query.col !== undefined && query.row !== undefined
				? `the cell at ${query.row}:${query.col}`
				: "text");
		const style = STYLE_KEYS.filter(
			(key) => query.style[key] !== undefined,
		).map((key) =>
			typeof query.style[key] === "boolean"
				? `${query.style[key] ? "" : "not "}${key}`
				: `${key} ${query.style[key]}`,
		);
		const where = [
			query.row !== undefined && query.label ? `on row ${query.row}` : "",
			query.col !== undefined && query.label ? `at column ${query.col}` : "",
		].filter(Boolean);
		return [
			what,
			...(style.length ? [`(${style.join(", ")})`] : []),
			...where,
		].join(" ");
	},

	/**
	 * Runs of text whose style is not the default, row by row: what a reader
	 * would otherwise only see as color.
	 */
	styles: (rows: TerminalCell[][], top = 1, limit = 400) => {
		const runs: Record<string, unknown>[] = [];
		for (const [index, cells] of rows.entries()) {
			let start = 0;
			for (let i = 1; i <= cells.length; i++) {
				const first = cells[start];
				const cell = cells[i];
				if (!first) break;
				if (cell && STYLE_KEYS.every((key) => cell[key] === first[key]))
					continue;
				const style = Object.fromEntries(
					STYLE_KEYS.filter((key) => first[key] !== DEFAULT_STYLE[key]).map(
						(key) => [key, first[key]],
					),
				);
				const text = cells
					.slice(start, i)
					.map((c) => c.char)
					.join("");
				if (
					Object.keys(style).length &&
					(text.trim() || style.bg || style.inverse)
				)
					runs.push({ row: top + index, col: start + 1, text, ...style });
				start = i;
			}
			if (runs.length >= limit) break;
		}
		return runs.slice(0, limit);
	},

	/**
	 * A key as tmux's `send-keys` names it: `Control+Shift+Tab` → `C-BTab`,
	 * `Alt+Enter` → `M-Enter`. tmux's own names pass through. A terminal has
	 * no Command key, so `Meta` is Alt and `Mod` is Control.
	 */
	key: (token: string): string => {
		const parts =
			token === "+"
				? ["+"]
				: token.endsWith("++")
					? [...token.slice(0, -2).split("+"), "+"]
					: token.split("+");
		const name = parts.pop() ?? "";
		const modifiers = new Set<string>(
			parts.map((part) => {
				const value = part.toLowerCase();
				const modifier =
					value === "c"
						? "Control"
						: value === "m"
							? "Alt"
							: value === "s"
								? "Shift"
								: Keys.modifier(part);
				if (modifier === "Control" || modifier === "Mod") return "C-";
				if (modifier === "Alt" || modifier === "Meta") return "M-";
				if (modifier === "Shift") return "S-";
				throw new Error(`Unknown modifier "${part}" in "${token}"`);
			}),
		);
		const names: Record<string, string> = {
			enter: "Enter",
			return: "Enter",
			tab: "Tab",
			escape: "Escape",
			esc: "Escape",
			backspace: "BSpace",
			bspace: "BSpace",
			delete: "DC",
			del: "DC",
			insert: "IC",
			up: "Up",
			down: "Down",
			left: "Left",
			right: "Right",
			arrowup: "Up",
			arrowdown: "Down",
			arrowleft: "Left",
			arrowright: "Right",
			home: "Home",
			end: "End",
			pageup: "PPage",
			pgup: "PPage",
			pagedown: "NPage",
			pgdn: "NPage",
			space: "Space",
		};
		let key = names[name.toLowerCase()] ?? name;
		if (/^f([1-9]|1[0-2])$/i.test(key)) key = key.toUpperCase();
		if (modifiers.has("S-") && key === "Tab") {
			modifiers.delete("S-");
			key = "BTab";
		} else if (modifiers.has("S-") && /^[a-z]$/.test(key)) {
			modifiers.delete("S-");
			key = key.toUpperCase();
		}
		const prefix = ["C-", "M-", "S-"].filter((m) => modifiers.has(m)).join("");
		return Screen.arg(prefix + key);
	},

	/**
	 * An argument tmux reads as it is: one ending in `;` would otherwise end
	 * the command there.
	 */
	arg: (value: string) =>
		value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value,

	/**
	 * The bytes a terminal sends for a mouse event, in whichever encoding the
	 * program asked for: SGR (`ESC [ < b ; x ; y M`) or the original X10 one.
	 */
	mouse: ({
		sgr,
		button,
		col,
		row,
		release = false,
		motion = false,
		modifiers = [],
	}: {
		sgr: boolean;
		/** 0 left, 1 middle, 2 right, 3 none (moving), 64–67 the wheel. */
		button: number;
		col: number;
		row: number;
		release?: boolean;
		motion?: boolean;
		modifiers?: readonly string[];
	}): number[] => {
		const held = new Set(
			modifiers.map((name) => {
				const modifier = Keys.modifier(name);
				return modifier === "Mod"
					? "Control"
					: modifier === "Meta"
						? "Alt"
						: modifier;
			}),
		);
		let code = button;
		if (held.has("Shift")) code += 4;
		if (held.has("Alt")) code += 8;
		if (held.has("Control")) code += 16;
		if (motion) code += 32;
		if (sgr) {
			const sequence = `\x1b[<${code};${col};${row}${release ? "m" : "M"}`;
			return [...sequence].map((c) => c.charCodeAt(0));
		}
		if (release) code = (code & ~3) | 3;
		const byte = (v: number) => Math.min(255, 32 + v);
		return [0x1b, 0x5b, 0x4d, byte(code), byte(col), byte(row)];
	},
} as const;
