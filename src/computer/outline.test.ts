import { Outline } from "./outline.ts";

const markdown = [
	'- [0] AXWindow "Calc" [id=main actions=[raise]]',
	'    - AXStaticText = "42" (Edit field)',
	"    - [1] AXButton (Clear) [id=Clear actions=[press]]",
	"    - [2] AXButton (7) [id=Seven actions=[press]]",
	"  - [3] AXToolbar",
	'    - [4] AXButton (7) [help="another seven" actions=[press]]',
	"  - [5] AXButton [actions=[press]]",
].join("\n");

const raw = (
	element_index: number,
	role: string,
	extra: Record<string, unknown> = {},
) => ({
	element_index,
	element_token: `s1:${element_index}`,
	role,
	depth: 1,
	parent_index: 0,
	actions: ["AXPress"],
	...extra,
});

const elements = Outline.elements(
	[
		raw(0, "AXWindow", { label: "Calc", parent_index: undefined, depth: 0 }),
		raw(1, "AXButton", { label: "Clear", enabled: true }),
		raw(2, "AXButton", {
			label: "7",
			enabled: true,
			screenshot_frame: { x: 10, y: 20, w: 40, h: 20 },
		}),
		raw(3, "AXToolbar"),
		raw(4, "AXButton", { label: "7", parent_index: 3, enabled: false }),
		raw(5, "AXButton", { subrole: "AXCloseButton" }),
	],
	markdown,
);

describe("Outline.elements", () => {
	it("reads elements, with ids from the outline's text", () => {
		expect(elements).toHaveLength(6);
		expect(elements[2]).toMatchObject({
			index: 2,
			token: "s1:2",
			id: "Seven",
			label: "7",
			frame: { x: 10, y: 20, width: 40, height: 20 },
		});
		expect(elements[4]?.id).toBeUndefined();
		expect(elements[2] && Outline.center(elements[2])).toEqual({
			x: 30,
			y: 30,
		});
	});
});

describe("Outline.select", () => {
	const pick = (selector: string) =>
		Outline.select(elements, selector).map((element) => element.index);

	it("selects by role, name, id and text", () => {
		expect(pick("role=button")).toEqual([1, 2, 4, 5]);
		expect(pick('role=button[name="7"]')).toEqual([2, 4]);
		expect(pick("role=AXToolbar")).toEqual([3]);
		expect(pick("id=Seven")).toEqual([2]);
		expect(pick("text=clear")).toEqual([1]);
		expect(pick('text="clear"')).toEqual([]);
		expect(pick("role=closebutton")).toEqual([5]);
	});

	it("narrows by state, scope and position", () => {
		expect(pick('role=button[name="7"][enabled]')).toEqual([2]);
		expect(pick('role=button[name="7"][disabled]')).toEqual([4]);
		expect(pick("role=toolbar >> role=button")).toEqual([4]);
		expect(pick("role=button >> nth=-1")).toEqual([5]);
		expect(pick("role=button >> nth=9")).toEqual([]);
	});

	it("refuses attributes elements do not have", () => {
		expect(() => pick("role=button[color=red]")).toThrow(/no "color"/);
	});
});

describe("Outline.keys", () => {
	it("tells like siblings apart and survives renumbering", () => {
		const keys = Outline.keys(elements);
		expect(new Set(keys.values()).size).toBe(elements.length);
		// The same window read again, with a row gone from above.
		const shifted = elements
			.filter((element) => element.index !== 1)
			.map((element) => ({
				...element,
				index: element.index > 1 ? element.index - 1 : element.index,
				parent: element.parent === 3 ? 2 : element.parent,
			}));
		const again = Outline.keys(shifted);
		expect(again.get(1)).toBe(keys.get(2));
		expect(again.get(3)).toBe(keys.get(4));
	});
});

describe("Outline text", () => {
	it("writes rows as refs", () => {
		expect(Outline.withRefs(markdown).split("\n")[2]).toBe(
			"    - [e1] AXButton (Clear) [id=Clear actions=[press]]",
		);
	});

	it("takes a subtree, a depth, and the rows that mention a text", () => {
		expect(Outline.subtree(markdown, 3)).toBe(
			'- [3] AXToolbar\n  - [4] AXButton (7) [help="another seven" actions=[press]]',
		);
		expect(Outline.shallow(markdown, 1)).toBe(
			'- [0] AXWindow "Calc" [id=main actions=[raise]]',
		);
		expect(Outline.filter(markdown, "another").split("\n")).toEqual([
			'- [0] AXWindow "Calc" [id=main actions=[raise]]',
			"  - [3] AXToolbar",
			'    - [4] AXButton (7) [help="another seven" actions=[press]]',
		]);
		expect(Outline.includes(markdown, "EDIT FIELD")).toBe(true);
	});
});
