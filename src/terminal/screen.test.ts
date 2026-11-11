import { Screen } from "./screen.ts";

const ESC = "\x1b";
const rows = Screen.parse(
	[
		`${ESC}[1;31mERR${ESC}[0m plain ${ESC}[42mGREEN${ESC}[0m`,
		`Ready> ${ESC}[38;2;255;0;0mhot${ESC}[0m ${ESC}[38;5;12mblue${ESC}[0m`,
		"日本 ok ok",
		"",
	].join("\n"),
);

describe("Screen.parse", () => {
	it("styles cells and keeps columns under wide characters", () => {
		expect(rows[0]?.[0]).toMatchObject({ char: "E", fg: "red", bold: true });
		expect(rows[0]?.[4]).toMatchObject({
			char: "p",
			fg: "default",
			bold: false,
		});
		expect(rows[1]?.[7]?.fg).toBe("#ff0000");
		expect(rows[1]?.[11]?.fg).toBe("brightblue");
		expect(Screen.text(rows[2] ?? [])).toBe("日本 ok ok");
		expect(rows[2]).toHaveLength(10);
	});
});

describe("Screen.find", () => {
	it("finds text, patterns and cells", () => {
		expect(Screen.find(rows, { text: "plain" })).toEqual([
			{ row: 1, col: 5, width: 5, text: "plain" },
		]);
		expect(Screen.find(rows, { regex: "o+k" })).toHaveLength(2);
		expect(Screen.find(rows, { text: "ok", col: 9 })).toEqual([
			{ row: 3, col: 9, width: 2, text: "ok" },
		]);
		expect(Screen.find(rows, { row: 1, col: 1 })[0]?.text).toBe("E");
	});

	it("narrows by style, by field or by selector", () => {
		expect(
			Screen.find(rows, { text: "ERR", fg: "red", bold: true }),
		).toHaveLength(1);
		expect(Screen.find(rows, { text: "plain", bold: true })).toHaveLength(0);
		expect(Screen.find(rows, { selector: '"ERR"[fg=red][bold]' })).toHaveLength(
			1,
		);
		expect(Screen.find(rows, { selector: "[bg=green]" })).toEqual([
			{ row: 1, col: 11, width: 5, text: "GREEN" },
		]);
		expect(Screen.find(rows, { selector: "/h.t/[fg=#F00]" })[0]?.text).toBe(
			"hot",
		);
	});

	it("ignores case for bare selector text only", () => {
		expect(Screen.find(rows, { selector: "text=ready" })).toHaveLength(1);
		expect(Screen.find(rows, { selector: '"ready"' })).toHaveLength(0);
		expect(Screen.find(rows, { text: "ready" })).toHaveLength(0);
	});

	it("picks one match with nth and numbers rows from top", () => {
		expect(Screen.find(rows, { selector: "text=ok >> nth=-1" })[0]?.col).toBe(
			9,
		);
		expect(Screen.find(rows, { text: "Ready" }, -1)[0]?.row).toBe(0);
	});

	it("refuses what a terminal cannot select by", () => {
		expect(() => Screen.find(rows, { selector: "role=button" })).toThrow(
			/no roles/,
		);
		expect(() => Screen.find(rows, { selector: '"x"[size=3]' })).toThrow(
			/no "size"/,
		);
	});
});

describe("Screen", () => {
	it("describes a match for messages", () => {
		expect(Screen.describe({ text: "Ready", fg: "red", row: 3 })).toBe(
			'"Ready" (fg red) on row 3',
		);
		expect(Screen.describe({ row: 2, col: 4 })).toBe("the cell at 2:4");
	});

	it("lists styled runs", () => {
		expect(Screen.styles(rows.slice(0, 1))).toEqual([
			{ row: 1, col: 1, text: "ERR", fg: "red", bold: true },
			{ row: 1, col: 11, text: "GREEN", bg: "green" },
		]);
	});

	it("names keys as tmux does", () => {
		expect(Screen.key("Control+c")).toBe("C-c");
		expect(Screen.key("Alt+Enter")).toBe("M-Enter");
		expect(Screen.key("Shift+Tab")).toBe("BTab");
		expect(Screen.key("Mod+Shift+a")).toBe("C-A");
		expect(Screen.key("pagedown")).toBe("NPage");
		expect(Screen.key("C-c")).toBe("C-c");
		expect(Screen.key(";")).toBe(String.raw`\;`);
	});

	it("encodes mouse events both ways", () => {
		const text = (bytes: number[]) => String.fromCharCode(...bytes);
		expect(text(Screen.mouse({ sgr: true, button: 0, col: 5, row: 2 }))).toBe(
			`${ESC}[<0;5;2M`,
		);
		expect(
			text(
				Screen.mouse({
					sgr: true,
					button: 0,
					col: 5,
					row: 2,
					release: true,
					modifiers: ["Shift", "Mod"],
				}),
			),
		).toBe(`${ESC}[<20;5;2m`);
		expect(
			Screen.mouse({ sgr: false, button: 0, col: 1, row: 1, release: true }),
		).toEqual([0x1b, 0x5b, 0x4d, 35, 33, 33]);
	});
});
