/**
 * Playwright-style selectors, for the surfaces Playwright does not reach.
 * A page takes its selectors straight to Playwright; a native window and a
 * terminal screen parse theirs here and match what they have against it.
 *
 *   text=Save                  contains "save", whatever the case
 *   text="Save"                exactly that, case and all
 *   text=/sav(e|ing)/i         a regular expression
 *   role=button[name="Save"]   by role, narrowed by attributes
 *   id=submit                  by identifier
 *   "Save"[bold][fg=red]       attributes on quoted text or a pattern
 *   [bg=blue]                  attributes alone
 *   role=row >> text=Total     each part within the one before
 *   text=Item >> nth=2         the third match (from 0; -1 is the last)
 *
 * A part with no engine is text.
 */

export type SelectorValue =
	| { kind: "contains"; text: string }
	| { kind: "exact"; text: string }
	| { kind: "regex"; pattern: RegExp };

export interface SelectorAttribute {
	name: string;
	/** Absent for a bare `[name]`, which asks only that it be set. */
	value?: SelectorValue;
}

export interface SelectorPart {
	engine: "text" | "role" | "id" | "nth" | "attributes";
	value?: SelectorValue;
	/** For `nth`. */
	index?: number;
	attributes: SelectorAttribute[];
}

const ENGINES = new Set(["text", "role", "id", "nth"]);

/** Splits on a separator that is outside quotes, brackets and patterns. */
const split = (source: string, separator: string): string[] => {
	const parts: string[] = [];
	let quote = "";
	let depth = 0;
	let start = 0;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "\\") {
			i++;
		} else if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[") {
			depth++;
		} else if (char === "]") {
			depth = Math.max(0, depth - 1);
		} else if (!depth && source.startsWith(separator, i)) {
			parts.push(source.slice(start, i));
			start = i + separator.length;
			i = start - 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
};

const unquote = (text: string) => text.replace(/\\(.)/g, "$1");

/** A quoted string, a pattern, or bare text, with how much of `source` it took. */
const readValue = (
	source: string,
): { value: SelectorValue; length: number } | undefined => {
	const quote = source[0];
	if (quote === '"' || quote === "'") {
		for (let i = 1; i < source.length; i++) {
			if (source[i] === "\\") i++;
			else if (source[i] === quote) {
				return {
					value: { kind: "exact", text: unquote(source.slice(1, i)) },
					length: i + 1,
				};
			}
		}
		throw new Error(`Unclosed quote in selector: ${source}`);
	}
	if (quote === "/") {
		for (let i = 1; i < source.length; i++) {
			if (source[i] === "\\") i++;
			else if (source[i] === "/") {
				const flags = /^[a-z]*/.exec(source.slice(i + 1))?.[0] ?? "";
				// Matched against one thing at a time, never from where it left off.
				const safe = [...new Set(flags.replace(/[gy]/g, ""))].join("");
				return {
					value: {
						kind: "regex",
						pattern: new RegExp(source.slice(1, i), safe),
					},
					length: i + 1 + flags.length,
				};
			}
		}
		throw new Error(`Unclosed pattern in selector: ${source}`);
	}
	return undefined;
};

/** Where the `[` that `source` opens with is closed, outside any quotes. */
const closing = (source: string) => {
	let quote = "";
	for (let i = 1; i < source.length; i++) {
		const char = source[i];
		if (char === "\\") i++;
		else if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "]") return i;
	}
	throw new Error(`Unclosed [ in selector: ${source}`);
};

const readAttributes = (source: string): SelectorAttribute[] => {
	const attributes: SelectorAttribute[] = [];
	let rest = source.trim();
	while (rest) {
		if (rest[0] !== "[") {
			throw new Error(`Expected [attribute] in selector, at: ${rest}`);
		}
		const group = rest.slice(1, closing(rest));
		const body = group.trim();
		const equals = body.indexOf("=");
		if (equals < 0) {
			if (!body) throw new Error("Empty [] in selector");
			attributes.push({ name: body.toLowerCase() });
		} else {
			const raw = body.slice(equals + 1).trim();
			const read = readValue(raw);
			attributes.push({
				name: body.slice(0, equals).trim().toLowerCase(),
				value:
					read && read.length === raw.length
						? read.value
						: { kind: "contains", text: raw },
			});
		}
		rest = rest.slice(group.length + 2).trim();
	}
	return attributes;
};

const parsePart = (source: string): SelectorPart => {
	const text = source.trim();
	if (!text) throw new Error("Empty selector");
	if (text[0] === "[") {
		return { engine: "attributes", attributes: readAttributes(text) };
	}

	const named = /^([a-z]+)=/i.exec(text);
	const engine =
		named?.[1] && ENGINES.has(named[1].toLowerCase())
			? (named[1].toLowerCase() as SelectorPart["engine"])
			: "text";
	const body = (
		engine === "text" && !named?.[0].toLowerCase().startsWith("text=")
			? text
			: text.slice((named?.[0] ?? "").length)
	).trim();

	if (engine === "nth") {
		const index = Number(body);
		if (!Number.isInteger(index)) {
			throw new Error(`nth= takes a whole number, not "${body}"`);
		}
		return { engine, index, attributes: [] };
	}

	const read = readValue(body);
	if (read) {
		return {
			engine,
			value: read.value,
			attributes: readAttributes(body.slice(read.length)),
		};
	}
	if (engine === "text") {
		// Bare text is all text: a `[` in it is just a character.
		return { engine, value: { kind: "contains", text: body }, attributes: [] };
	}
	const bracket = body.indexOf("[");
	const name = (bracket < 0 ? body : body.slice(0, bracket)).trim();
	if (!name) throw new Error(`${engine}= needs a value`);
	return {
		engine,
		value: { kind: engine === "id" ? "exact" : "contains", text: name },
		attributes: bracket < 0 ? [] : readAttributes(body.slice(bracket)),
	};
};

export const Selector = {
	parse: (selector: string): SelectorPart[] =>
		split(selector, ">>").map(parsePart),

	/**
	 * Whether text is what a value asks for. Bare text is found anywhere in
	 * it, whatever the case; quoted text has to be all of it (or, with
	 * `within`, only appear in it as written).
	 */
	matches: (
		value: SelectorValue,
		text: string | undefined | null,
		{ within = false }: { within?: boolean } = {},
	): boolean => {
		if (text === undefined || text === null) return false;
		if (value.kind === "regex") return value.pattern.test(text);
		if (value.kind === "contains") {
			return text.toLowerCase().includes(value.text.toLowerCase());
		}
		return within
			? text.includes(value.text)
			: text.replace(/\s+/g, " ").trim() === value.text;
	},

	/** A value as a selector spells it, for error messages. */
	describe: (value: SelectorValue) =>
		value.kind === "regex"
			? String(value.pattern)
			: value.kind === "exact"
				? JSON.stringify(value.text)
				: value.text,
} as const;
