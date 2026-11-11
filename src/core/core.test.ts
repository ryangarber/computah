import { Keys } from "./keys.ts";
import { Frames, runSteps, StepError } from "./run.ts";
import { Selector } from "./selector.ts";

describe("Keys", () => {
	it("parses chords and names keys one way", () => {
		expect(Keys.parse("Control+A Backspace esc", "linux")).toEqual([
			{ key: "A", modifiers: ["Control"] },
			{ key: "Backspace", modifiers: [] },
			{ key: "Escape", modifiers: [] },
		]);
	});

	it("resolves Mod by platform and orders modifiers", () => {
		expect(Keys.chord("Shift+Mod+k", "darwin").modifiers).toEqual([
			"Shift",
			"Meta",
		]);
		expect(Keys.chord("cmdorctrl+k", "win32").modifiers).toEqual(["Control"]);
	});

	it("reads the plus key", () => {
		expect(Keys.chord("+")).toEqual({ key: "+", modifiers: [] });
		expect(Keys.chord("Control++", "linux")).toEqual({
			key: "+",
			modifiers: ["Control"],
		});
	});

	it("rejects unknown modifiers and empty input", () => {
		expect(() => Keys.chord("Hyper+a")).toThrow(/Unknown modifier/);
		expect(() => Keys.parse("  ")).toThrow(/No keys/);
	});

	it("formats for Playwright", () => {
		expect(Keys.parse("Mod+L f5", "darwin").map(Keys.format)).toEqual([
			"Meta+L",
			"F5",
		]);
	});
});

describe("Selector", () => {
	it("parses engines, quotes, patterns and attributes", () => {
		expect(Selector.parse('role=button[name="Save"][enabled]')).toEqual([
			{
				engine: "role",
				value: { kind: "contains", text: "button" },
				attributes: [
					{ name: "name", value: { kind: "exact", text: "Save" } },
					{ name: "enabled" },
				],
			},
		]);
		const [pattern] = Selector.parse("text=/sav(e|ing)/i");
		expect(pattern?.value).toEqual({ kind: "regex", pattern: /sav(e|ing)/i });
	});

	it("chains with >> outside quotes and brackets", () => {
		const parts = Selector.parse(
			'role=row[name="a >> b"] >> text=Total >> nth=-1',
		);
		expect(parts.map((part) => part.engine)).toEqual(["role", "text", "nth"]);
		expect(parts[2]?.index).toBe(-1);
	});

	it("treats a bare part as text, brackets and all", () => {
		expect(Selector.parse("items [3]")).toEqual([
			{
				engine: "text",
				value: { kind: "contains", text: "items [3]" },
				attributes: [],
			},
		]);
		expect(Selector.parse('"Ready"[fg=green][bold]')[0]?.attributes).toEqual([
			{ name: "fg", value: { kind: "contains", text: "green" } },
			{ name: "bold" },
		]);
		expect(Selector.parse("[bg=blue]")[0]?.engine).toBe("attributes");
	});

	it("matches bare text loosely and quoted text exactly", () => {
		expect(
			Selector.matches({ kind: "contains", text: "save" }, "Save As"),
		).toBe(true);
		expect(Selector.matches({ kind: "exact", text: "Save" }, "Save As")).toBe(
			false,
		);
		expect(
			Selector.matches({ kind: "exact", text: "Save" }, "Save As", {
				within: true,
			}),
		).toBe(true);
		expect(Selector.matches({ kind: "exact", text: "Save" }, undefined)).toBe(
			false,
		);
	});

	it("says what is wrong with a selector", () => {
		expect(() => Selector.parse('text="open')).toThrow(/Unclosed quote/);
		expect(() => Selector.parse("nth=one")).toThrow(/whole number/);
		expect(() => Selector.parse("role=button[name")).toThrow(/Unclosed \[/);
	});
});

describe("runSteps", () => {
	const steps = [{ action: "a" }, { action: "b" }, { action: "c" }];

	it("stops at the first failure and counts the rest as skipped", async () => {
		const result = await runSteps({
			steps,
			execute: async (step) => {
				if (step.action === "b") throw new StepError("no", { screen: 1 });
				return step.action === "a" ? "done" : undefined;
			},
		});
		expect(result).toEqual({
			steps: [
				{ action: "a", ok: true, value: "done" },
				{ action: "b", ok: false, error: "no", value: { screen: 1 } },
			],
			skipped: 1,
		});
	});

	it("skips everything left once aborted", async () => {
		const controller = new AbortController();
		const result = await runSteps({
			steps,
			signal: controller.signal,
			execute: async () => controller.abort(),
		});
		expect(result.steps).toHaveLength(1);
		expect(result.skipped).toBe(2);
	});
});

describe("Frames", () => {
	it("maps image pixels to the surface and back", () => {
		const scale = Frames.fit(2000, 1000, 500);
		expect(scale).toBe(0.25);
		expect(Frames.fit(300, 200, 500)).toBe(1);
		const frame = { scale, x: 100, y: 50 };
		expect(Frames.toSurface(frame, { x: 25, y: 10 })).toEqual({
			x: 200,
			y: 90,
		});
		expect(Frames.toImage(frame, { x: 200, y: 90 })).toEqual({ x: 25, y: 10 });
	});
});
