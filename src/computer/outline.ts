import {
	Selector,
	type SelectorAttribute,
	type SelectorPart,
} from "../core/selector.ts";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One actionable element of a window's accessibility tree. */
export interface OutlineElement {
	index: number;
	/** What the driver acts on; good until the window is read again. */
	token: string;
	role: string;
	subrole?: string;
	id?: string;
	label?: string;
	title?: string;
	description?: string;
	help?: string;
	value?: string;
	enabled?: boolean;
	selected?: boolean;
	actions: string[];
	/** Where it is in the window's latest screenshot, in that image's pixels. */
	frame?: Rect;
	parent?: number;
	depth: number;
}

const text = (value: unknown) =>
	typeof value === "string"
		? value
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: undefined;

const rect = (value: unknown): Rect | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const { x, y, w, h, width, height } = value as Record<string, unknown>;
	const size = [w ?? width, h ?? height];
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof size[0] !== "number" ||
		typeof size[1] !== "number"
	)
		return undefined;
	return { x, y, width: size[0], height: size[1] };
};

/** `AXButton` and `Button` as selectors spell them: `button`. */
const normalizeRole = (role: string) =>
	role
		.replace(/^AX/, "")
		.replace(/[\s_-]/g, "")
		.toLowerCase();

/** The names an element goes by, most telling first. */
const names = (element: OutlineElement) =>
	[element.label, element.title, element.description].filter(
		(name): name is string => !!name,
	);

const matchesAttribute = (
	element: OutlineElement,
	{ name, value }: SelectorAttribute,
): boolean => {
	const flag = (state: boolean | undefined) =>
		value?.kind === "contains" && value.text === "false"
			? state === false
			: state === true;
	const oneOf = (candidates: (string | undefined)[]) =>
		value
			? candidates.some((candidate) => Selector.matches(value, candidate))
			: candidates.some(Boolean);
	switch (name) {
		case "name":
		case "label":
			return oneOf(names(element));
		case "title":
			return oneOf([element.title]);
		case "description":
			return oneOf([element.description]);
		case "help":
			return oneOf([element.help]);
		case "value":
			return oneOf([element.value]);
		case "id":
			return oneOf([element.id]);
		case "role":
			return oneOf([normalizeRole(element.role), element.role]);
		case "subrole":
			return oneOf([
				element.subrole && normalizeRole(element.subrole),
				element.subrole,
			]);
		case "enabled":
			return flag(element.enabled);
		case "disabled":
			return flag(element.enabled === undefined ? undefined : !element.enabled);
		case "selected":
		case "checked":
			return flag(element.selected);
		default:
			throw new Error(
				`An element has no "${name}" to select by: use name, value, id, title, description, role, enabled or selected.`,
			);
	}
};

const matchesPart = (element: OutlineElement, part: SelectorPart): boolean => {
	const { value } = part;
	if (part.engine === "role" && value) {
		const wanted =
			value.kind === "regex" ? undefined : normalizeRole(value.text);
		const ok = wanted
			? normalizeRole(element.role) === wanted ||
				(!!element.subrole && normalizeRole(element.subrole) === wanted)
			: Selector.matches(value, normalizeRole(element.role));
		if (!ok) return false;
	} else if (part.engine === "id" && value) {
		if (!Selector.matches(value, element.id)) return false;
	} else if (part.engine === "text" && value) {
		const candidates = [...names(element), element.value, element.help];
		if (!candidates.some((candidate) => Selector.matches(value, candidate))) {
			return false;
		}
	}
	return part.attributes.every((attribute) =>
		matchesAttribute(element, attribute),
	);
};

export const Outline = {
	normalizeRole,

	/** What an element is called, for messages. */
	name: (element: OutlineElement) => names(element)[0],

	/**
	 * The elements of a window read, from the driver's structured result.
	 * Identifiers come from the outline's text, which is the only place the
	 * driver puts them.
	 */
	elements: (structured: unknown, markdown = ""): OutlineElement[] => {
		const ids = new Map<number, string>();
		for (const line of markdown.split("\n")) {
			const row = /^\s*- \[(\d+)\] .*\[id=(?:"([^"]*)"|(\S+?))[\s\]]/.exec(
				line,
			);
			if (row) ids.set(Number(row[1]), row[2] ?? row[3] ?? "");
		}
		if (!Array.isArray(structured)) return [];
		const elements: OutlineElement[] = [];
		for (const raw of structured as Record<string, unknown>[]) {
			if (!raw || typeof raw.element_index !== "number") continue;
			const index = raw.element_index;
			const id = text(raw.id) ?? text(raw.identifier) ?? ids.get(index);
			const frame = rect(raw.screenshot_frame);
			elements.push({
				index,
				token: text(raw.element_token) ?? "",
				role: text(raw.role) ?? "",
				...(text(raw.subrole) ? { subrole: text(raw.subrole) } : {}),
				...(id ? { id } : {}),
				...(text(raw.label) ? { label: text(raw.label) } : {}),
				...(text(raw.title) ? { title: text(raw.title) } : {}),
				...(text(raw.description)
					? { description: text(raw.description) }
					: {}),
				...(text(raw.help) ? { help: text(raw.help) } : {}),
				...(text(raw.value) !== undefined ? { value: text(raw.value) } : {}),
				...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
				...(typeof raw.selected === "boolean"
					? { selected: raw.selected }
					: {}),
				actions: Array.isArray(raw.actions)
					? raw.actions.filter((a): a is string => typeof a === "string")
					: [],
				...(frame ? { frame } : {}),
				...(typeof raw.parent_index === "number"
					? { parent: raw.parent_index }
					: {}),
				depth: typeof raw.depth === "number" ? raw.depth : 0,
			});
		}
		return elements;
	},

	/**
	 * A key for each element that survives a re-read: what it is, under what,
	 * and which of its like siblings it is. A ref keeps pointing at its
	 * element through it, though the driver renumbers rows every read.
	 */
	keys: (elements: OutlineElement[]): Map<number, string> => {
		const keys = new Map<number, string>();
		const seen = new Map<string, number>();
		for (const element of elements) {
			const parent =
				element.parent === undefined ? "" : (keys.get(element.parent) ?? "");
			const base = `${parent}/${[
				element.role,
				element.subrole ?? "",
				element.id ?? "",
				names(element)[0] ?? "",
			].join("|")}`;
			const ordinal = seen.get(base) ?? 0;
			seen.set(base, ordinal + 1);
			keys.set(element.index, `${base}#${ordinal}`);
		}
		return keys;
	},

	/**
	 * The elements a selector picks, in outline order. Each `>>` part is
	 * matched within the elements the part before it picked.
	 */
	select: (elements: OutlineElement[], selector: string): OutlineElement[] => {
		const byIndex = new Map(
			elements.map((element) => [element.index, element]),
		);
		const within = (element: OutlineElement, scope: Set<number>) => {
			for (
				let parent = element.parent;
				parent !== undefined;
				parent = byIndex.get(parent)?.parent
			) {
				if (scope.has(parent)) return true;
			}
			return false;
		};

		let found = elements;
		let scope: Set<number> | undefined;
		for (const part of Selector.parse(selector)) {
			if (part.engine === "nth") {
				const one = found.at(part.index ?? 0);
				found = one ? [one] : [];
			} else {
				const scoped = scope;
				found = elements.filter(
					(element) =>
						(!scoped || within(element, scoped)) && matchesPart(element, part),
				);
			}
			scope = new Set(found.map((element) => element.index));
		}
		return found;
	},

	/** The middle of an element, in its window's screenshot pixels. */
	center: (element: OutlineElement) =>
		element.frame
			? {
					x: Math.round(element.frame.x + element.frame.width / 2),
					y: Math.round(element.frame.y + element.frame.height / 2),
				}
			: undefined,

	/** The driver's outline with its row numbers written as refs: `[5]` → `[e5]`. */
	withRefs: (markdown: string) =>
		markdown.replace(/^(\s*- )\[(\d+)\] /gm, "$1[e$2] "),

	/** One row of the outline and everything indented under it. */
	subtree: (markdown: string, index: number) => {
		const lines = markdown.split("\n");
		const start = lines.findIndex((line) =>
			new RegExp(`^\\s*- \\[${index}\\] `).test(line),
		);
		if (start < 0) return "";
		const indent = /^\s*/.exec(lines[start] ?? "")?.[0].length ?? 0;
		let end = start + 1;
		while (end < lines.length) {
			const line = lines[end] ?? "";
			if (line.trim() && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
			end++;
		}
		return lines
			.slice(start, end)
			.map((line) => line.slice(indent))
			.join("\n");
	},

	/** The outline down to a number of levels. */
	shallow: (markdown: string, depth: number) => {
		const lines = markdown.split("\n");
		const base = Math.min(
			...lines
				.filter((line) => line.trim())
				.map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
		);
		return lines
			.filter(
				(line) =>
					line.trim() &&
					((/^\s*/.exec(line)?.[0].length ?? 0) - base) / 2 < depth,
			)
			.join("\n");
	},

	/**
	 * The rows that mention a text, whatever the case, each under the rows
	 * that contain it.
	 */
	filter: (markdown: string, find: string) => {
		const lines = markdown.split("\n");
		const needle = find.toLowerCase();
		const keep = new Set<number>();
		const indent = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;
		for (const [index, line] of lines.entries()) {
			if (!line.toLowerCase().includes(needle)) continue;
			keep.add(index);
			let level = indent(line);
			for (let above = index - 1; above >= 0 && level > 0; above--) {
				const candidate = lines[above] ?? "";
				if (candidate.trim() && indent(candidate) < level) {
					keep.add(above);
					level = indent(candidate);
				}
			}
		}
		return lines.filter((_, index) => keep.has(index)).join("\n");
	},

	/** Whether a text is anywhere in the outline, whatever the case. */
	includes: (markdown: string, needle: string) =>
		markdown.toLowerCase().includes(needle.toLowerCase()),
} as const;
