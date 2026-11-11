import { z } from "zod";
import {
	zButton,
	zCount,
	zImage,
	zImageOptions,
	zInstallResult,
	zKeys,
	zModifier,
	zPermission,
	zPoint,
	zRequirement,
	zRunResult,
	zSelector,
	zTimeout,
} from "../core/grammar.ts";

/**
 * What an element step acts on. A `ref` comes from a `read` tree and is the
 * most precise; a `selector` is any Playwright selector (`css`, `text=`,
 * `role=button[name="Save"]`) and survives navigation, which is what makes it
 * the one to use in a chain written before the page has been read; `x`/`y` are
 * pixels of the latest screenshot (CSS pixels of the viewport, unless that
 * screenshot was scaled down).
 */
const zTarget = {
	ref: z
		.string()
		.optional()
		.describe("An element ref from a `read` tree, e.g. `e12`."),
	selector: zSelector(
		'A Playwright selector: CSS, `text=Sign in`, `role=button[name="Save"]`.',
	),
};

const zViewportPoint = zPoint("the latest screenshot's pixels");

export const zBrowserStep = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("navigate"),
			url: z.string().describe('A URL, or "back", "forward" or "reload".'),
		})
		.describe("Go to a URL, or move through history."),
	z
		.object({
			action: z.literal("read"),
			format: z
				.enum(["tree", "text", "html"])
				.optional()
				.describe(
					"`tree` (default): visible elements with refs for interacting. `text`: rendered text. `html`: markup.",
				),
			...zTarget,
			maxLength: z
				.number()
				.optional()
				.describe("Cap on characters returned (default 20000)."),
		})
		.describe("Read the page, or only the element targeted."),
	z
		.object({
			action: z.literal("click"),
			...zTarget,
			...zViewportPoint,
			button: zButton.optional(),
			count: zCount,
			modifiers: z.array(zModifier).optional(),
		})
		.describe("Click an element by ref or selector, or a point by x/y."),
	z
		.object({
			action: z.literal("hover"),
			...zTarget,
			...zViewportPoint,
		})
		.describe("Move the mouse over an element or point."),
	z
		.object({
			action: z.literal("drag"),
			...zTarget,
			...zViewportPoint,
			to: z
				.object({ ...zTarget, ...zViewportPoint })
				.describe("Where to let go: an element, or a point by x/y."),
			button: zButton.optional(),
			modifiers: z.array(zModifier).optional(),
		})
		.describe("Press on an element or point, move to another, and let go."),
	z
		.object({
			action: z.literal("type"),
			text: z.string(),
			...zTarget,
			clear: z
				.boolean()
				.optional()
				.describe(
					"With a target, replace its value (default true) rather than type after it. A <select> is set to the matching option.",
				),
			submit: z.boolean().optional().describe("Press Enter afterwards."),
		})
		.describe("Type text into the targeted field, or into whatever has focus."),
	z
		.object({
			action: z.literal("press"),
			keys: zKeys('"Enter", "Tab Tab Enter", "Control+A Backspace", "Mod+L"'),
		})
		.describe("Press keys or shortcuts."),
	z
		.object({
			action: z.literal("scroll"),
			...zTarget,
			...zViewportPoint,
			dx: z.number().optional(),
			dy: z
				.number()
				.optional()
				.describe("Pixels to scroll down (negative for up). Default 600."),
		})
		.describe(
			"Scroll a target into view, or scroll the page (or the point x/y) by dx/dy.",
		),
	z
		.object({
			action: z.literal("wait"),
			ms: z.number().optional().describe("Sleep this long (max 30000)."),
			...zTarget,
			state: z
				.enum(["visible", "hidden", "attached", "detached"])
				.optional()
				.describe("For a ref, selector or text; default visible."),
			text: z.string().optional().describe("Wait for this text to appear."),
			gone: z
				.boolean()
				.optional()
				.describe(
					"Wait until it is no longer there: the same as state `hidden`.",
				),
			url: z
				.string()
				.optional()
				.describe("Wait for the URL to match this glob."),
			script: z
				.string()
				.optional()
				.describe("Wait until this JS expression is truthy."),
			load: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
			timeout: zTimeout(10_000, 120_000),
		})
		.describe("Wait for time, or for exactly one condition."),
	z
		.object({
			action: z.literal("evaluate"),
			script: z
				.string()
				.describe(
					"A JS expression, a function, or a function body using `return`. With a target, the element is passed as `el`. Promises are awaited; the result must be JSON-serializable.",
				),
			...zTarget,
		})
		.describe("Run JavaScript in the page."),
	z
		.object({
			action: z.literal("console"),
			level: z
				.enum(["all", "warning", "error"])
				.optional()
				.describe("Minimum level (default all)."),
			limit: z.number().optional().describe("Most recent N (default 50)."),
			clear: z.boolean().optional().describe("Empty the log after reading."),
		})
		.describe("Read the console messages and page errors of the tab."),
	z
		.object({
			action: z.literal("resize"),
			width: z
				.number()
				.optional()
				.describe("Viewport width in CSS pixels (200–4000)."),
			height: z
				.number()
				.optional()
				.describe("Viewport height in CSS pixels (200–4000)."),
			reset: z
				.boolean()
				.optional()
				.describe("Go back to the default size instead."),
		})
		.describe(
			"Resize the active tab's viewport, e.g. 390×844 to see a page as a phone would. The size stays with the tab for later calls until reset.",
		),
	z
		.object({
			action: z.literal("screenshot"),
			...zTarget,
			fullPage: z.boolean().optional(),
			...zImageOptions,
		})
		.describe(
			"Capture the viewport, the full page, or an element. Later x/y are the pixels of the latest viewport capture.",
		),
	z
		.object({
			action: z.literal("tabs"),
			select: z.number().optional().describe("Switch to the tab at index."),
			open: z.string().optional().describe("Open a new tab at this URL."),
			close: z.number().optional().describe("Close the tab at index."),
		})
		.describe("List tabs, or open, switch or close one."),
]);
export type BrowserStep = z.infer<typeof zBrowserStep>;

export const zBrowserRunResult = zRunResult.extend({
	url: z.string(),
	title: z.string(),
	/** One per `screenshot` step, then the final one when asked for. */
	screenshots: z.array(zImage),
});
export type BrowserRunResult = z.infer<typeof zBrowserRunResult>;

export const zBrowserInstall = z.object({
	name: z.string(),
	path: z.string(),
	/** Downloaded by Playwright, installed on the system, or passed in. */
	source: z.enum(["playwright", "system", "option"]),
	version: z.string().optional(),
});
export type BrowserInstall = z.infer<typeof zBrowserInstall>;

export const zBrowserTab = z.object({
	index: z.number(),
	url: z.string(),
	title: z.string(),
	active: z.boolean(),
});
export type BrowserTab = z.infer<typeof zBrowserTab>;

/** What was found to drive a browser with, and whether it is enough. */
export const zBrowserStatus = z.object({
	available: z.boolean(),
	error: z.string().optional(),
	/** The Node (or Bun) the driver runs in. */
	runtime: zRequirement,
	playwright: zRequirement,
	browsers: z.array(zBrowserInstall),
	/** The install a run will launch: the first of `browsers`. */
	browser: zBrowserInstall.optional(),
	/**
	 * Whether the browser window can be shown here. Where it cannot (no
	 * desktop, as over SSH or a broken WSLg), showing it is asked for in vain
	 * and the browser runs headless instead.
	 */
	display: z.object({ available: z.boolean(), error: z.string().optional() }),
	permissions: z.array(zPermission),
});
export type BrowserStatus = z.infer<typeof zBrowserStatus>;

export const zBrowserInstallResult = zInstallResult;
