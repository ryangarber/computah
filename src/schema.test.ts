import { z } from "zod";
import { zBrowserStep, zComputerStep, zTerminalStep } from "./schema.ts";

/** The actions a step schema takes. */
const actions = (schema: {
	options: readonly { shape: { action: { value: string } } }[];
}) => schema.options.map((option) => option.shape.action.value);

describe("the shared grammar", () => {
	it("gives every surface the same core actions", () => {
		const shared = [
			"click",
			"hover",
			"drag",
			"type",
			"press",
			"scroll",
			"wait",
		];
		for (const schema of [zBrowserStep, zTerminalStep, zComputerStep]) {
			expect(actions(schema)).toEqual(expect.arrayContaining(shared));
		}
	});

	it("parses the same step shapes on each surface", () => {
		const press = { action: "press", keys: "Mod+A Backspace" };
		expect(zBrowserStep.parse(press)).toEqual(press);
		expect(zTerminalStep.parse(press)).toEqual(press);
		expect(zComputerStep.parse(press)).toEqual(press);

		const click = {
			action: "click",
			selector: "text=Save",
			button: "right",
			count: 2,
			modifiers: ["Mod", "Shift"],
		};
		expect(zBrowserStep.parse(click)).toEqual(click);
		expect(zTerminalStep.parse(click)).toEqual(click);
		expect(zComputerStep.parse(click)).toEqual(click);

		const drag = {
			action: "drag",
			selector: "text=a",
			to: { selector: "text=b" },
		};
		expect(zBrowserStep.parse(drag)).toEqual(drag);
		expect(zTerminalStep.parse(drag)).toEqual(drag);
		expect(zComputerStep.parse(drag)).toEqual(drag);
	});

	it("rejects steps it does not know", () => {
		expect(zBrowserStep.safeParse({ action: "teleport" }).success).toBe(false);
		expect(
			zComputerStep.safeParse({ action: "click", button: "fourth" }).success,
		).toBe(false);
		expect(zTerminalStep.safeParse({ action: "press" }).success).toBe(false);
	});

	it("serializes to JSON Schema for a tool definition", () => {
		for (const schema of [zBrowserStep, zTerminalStep, zComputerStep]) {
			expect(() =>
				z.toJSONSchema(z.object({ steps: z.array(schema) })),
			).not.toThrow();
		}
	});
});
