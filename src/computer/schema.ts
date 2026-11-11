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
 * What an element step acts on: a `ref` from a `read` outline, a `selector`
 * matched against the window's accessibility tree, or `x`/`y` pixels in the
 * latest screenshot. A ref or selector acts on the element itself, in the
 * background, without moving the pointer or raising the window.
 */
const zTarget = {
	ref: z
		.string()
		.optional()
		.describe("An element ref from a `read` outline, e.g. `e12`."),
	selector: zSelector(
		'A selector over the accessibility tree: `role=button[name="Save"]`, `text=Save`, `text="Save" >> nth=1`. Roles are lower case without a platform prefix (`AXButton` is `button`); `[name=…]`, `[value=…]`, `[enabled]` and `[selected]` narrow them.',
	),
	...zPoint("the latest screenshot's pixels"),
};

/**
 * Background delivery is the default everywhere: nothing is raised and the
 * user's pointer and focus are left alone. `foreground` is the way out for
 * the few surfaces that only take real input.
 */
const zDelivery = {
	foreground: z
		.boolean()
		.optional()
		.describe(
			"Briefly bring the window forward to deliver this, then put back what was in front. Only for input that did not land in the background.",
		),
};

export const zComputerStep = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("windows"),
			app: z
				.string()
				.optional()
				.describe("Only windows of apps whose name contains this."),
		})
		.describe("List open windows with their ids (`w3`) and apps."),
	z
		.object({
			action: z.literal("open"),
			app: z
				.string()
				.describe(
					"An app name (`Calculator`), bundle id (`com.apple.calculator`) or path to an app.",
				),
			args: z.array(z.string()).optional(),
			urls: z
				.array(z.string())
				.optional()
				.describe("Files or URLs for the app to open."),
			timeout: z
				.number()
				.optional()
				.describe("How long to wait for its window (default 15000)."),
		})
		.describe(
			"Open an app in the background, or find it if it is already open, and make its window the target.",
		),
	z
		.object({
			action: z.literal("read"),
			ref: z
				.string()
				.optional()
				.describe("Read only this element and what it contains."),
			find: z
				.string()
				.optional()
				.describe(
					"Show only elements whose role, name or value contains this, and the elements that contain them.",
				),
			depth: z.number().optional().describe("Levels to read (default 25)."),
			maxLength: z
				.number()
				.optional()
				.describe("Cap on characters returned (default 20000)."),
		})
		.describe(
			"Read the target window's accessibility outline, with refs to act on.",
		),
	z
		.object({
			action: z.literal("click"),
			...zTarget,
			button: zButton.optional(),
			count: zCount,
			modifiers: z.array(zModifier).optional(),
			...zDelivery,
		})
		.describe("Click an element by ref or selector, or a point by x/y."),
	z
		.object({
			action: z.literal("hover"),
			...zTarget,
		})
		.describe(
			"Move the virtual cursor over an element or point, hovering it where the app can be hovered in the background.",
		),
	z
		.object({
			action: z.literal("drag"),
			...zTarget,
			to: z
				.object(zTarget)
				.describe("Where to let go: an element, or a point by x/y."),
			button: zButton.optional(),
			modifiers: z.array(zModifier).optional(),
			...zDelivery,
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
					"With a ref or selector, replace its value (default true) rather than type after it. A popup is set to the matching option.",
				),
			submit: z.boolean().optional().describe("Press Enter afterwards."),
			...zDelivery,
		})
		.describe(
			"Type text into the targeted field, or into whatever has focus in the window.",
		),
	z
		.object({
			action: z.literal("press"),
			keys: zKeys('"Enter", "Tab Tab Enter", "Mod+A Backspace"'),
			ref: zTarget.ref,
			selector: zTarget.selector,
			...zDelivery,
		})
		.describe(
			"Press keys or shortcuts in the target window, or in one element of it.",
		),
	z
		.object({
			action: z.literal("scroll"),
			...zTarget,
			dx: z
				.number()
				.optional()
				.describe("Wheel notches right, negative for left."),
			dy: z
				.number()
				.optional()
				.describe("Wheel notches down (negative for up). Default 5."),
			...zDelivery,
		})
		.describe("Scroll at an element or point, or whatever has focus."),
	z
		.object({
			action: z.literal("wait"),
			ms: z.number().optional().describe("Sleep this long (max 30000)."),
			selector: zTarget.selector,
			text: z
				.string()
				.optional()
				.describe("Wait until this text is in the window, whatever the case."),
			gone: z
				.boolean()
				.optional()
				.describe("Wait until nothing matches instead."),
			timeout: zTimeout(10_000, 60_000),
		})
		.describe("Wait for time, or for an element or text to appear or go."),
	z
		.object({
			action: z.literal("screenshot"),
			screen: z
				.boolean()
				.optional()
				.describe("The whole screen rather than the target window."),
			ref: z.string().optional().describe("Zoom in on this element."),
			selector: zTarget.selector,
			region: z
				.object({
					x: z.number(),
					y: z.number(),
					width: z.number(),
					height: z.number(),
				})
				.optional()
				.describe("Zoom in on this rectangle of the latest window screenshot."),
			...zImageOptions,
		})
		.describe(
			"Capture the target window, the screen, or part of the window; later x/y are this image's pixels.",
		),
	z
		.object({
			action: z.literal("menu"),
			path: z
				.array(z.string())
				.min(1)
				.describe(
					'Menu labels from the menu bar down: `["File", "Save As…"]`.',
				),
		})
		.describe("Choose an item from the app's menus, without raising it."),
	z
		.object({
			action: z.literal("clipboard"),
			text: z
				.string()
				.optional()
				.describe(
					"Put this on the clipboard. Without it, the clipboard is read.",
				),
		})
		.describe("Read the clipboard's text, or set it."),
	z
		.object({
			action: z.literal("window"),
			op: z.enum([
				"activate",
				"minimize",
				"maximize",
				"restore",
				"close",
				"move",
				"resize",
			]),
			x: z.number().optional(),
			y: z.number().optional(),
			width: z.number().optional(),
			height: z.number().optional(),
		})
		.describe(
			"Bring forward, minimize, maximize, restore, close, move or resize the target window. Only `activate` and `restore` take the user's focus.",
		),
]);
export type ComputerStep = z.infer<typeof zComputerStep>;

export const zComputerWindow = z.object({
	/** `w3`: stable for as long as the window is open. */
	id: z.string(),
	app: z.string(),
	title: z.string().optional(),
	pid: z.number(),
	bounds: z
		.object({
			x: z.number(),
			y: z.number(),
			width: z.number(),
			height: z.number(),
		})
		.optional(),
	/** Whether it is on screen now: not minimized, hidden or on another desktop. */
	visible: z.boolean().optional(),
});
export type ComputerWindow = z.infer<typeof zComputerWindow>;

export const zComputerRunResult = zRunResult.extend({
	/** The window the steps ended on, when there was one. */
	window: zComputerWindow.pick({ id: true, app: true, title: true }).optional(),
	/** One per `screenshot` step, then the final one when asked for. */
	screenshots: z.array(zImage),
});
export type ComputerRunResult = z.infer<typeof zComputerRunResult>;

/**
 * How the computer is driven.
 * - `in-process`: the driver runs inside the host, under the host's own
 *   permissions. Works wherever the native library does; has no virtual
 *   cursor on macOS.
 * - `app`: the installed Cua Driver app's service, under its permissions.
 *   Draws the virtual cursor.
 * - `embedded`: a driver binary started as the host's child, under the host's
 *   permissions, with the virtual cursor.
 * - `external`: a driver the consumer connected or passed in.
 */
export const zComputerMode = z.enum([
	"in-process",
	"app",
	"embedded",
	"external",
]);
export type ComputerMode = z.infer<typeof zComputerMode>;

export const zComputerCursor = z.object({
	/** Whether the virtual cursor is drawn for the mode in use. */
	available: z.boolean(),
	/**
	 * Why not: `unsupported` (this platform has none), `not-installed` (the
	 * Cua Driver app is missing), `not-running` (it is installed but its
	 * service could not be reached), `permissions` (it lacks access),
	 * `disabled` (the consumer turned it off).
	 */
	reason: z
		.enum([
			"unsupported",
			"not-installed",
			"not-running",
			"permissions",
			"disabled",
		])
		.optional(),
});
export type ComputerCursor = z.infer<typeof zComputerCursor>;

/** Whether the host can control the computer, and what is missing if not. */
export const zComputerStatus = z.object({
	available: z.boolean(),
	error: z.string().optional(),
	os: z.string(),
	/** The mode a run would use now. */
	mode: zComputerMode.optional(),
	/** The native driver library, which every mode goes through. */
	sdk: zRequirement,
	/** The Cua Driver app and its command line, for the `app` mode. */
	app: zRequirement,
	/**
	 * Every grant that matters: the host's own (`owner: "host"`), and the Cua
	 * Driver app's (`owner: "app"`) where it is installed and answering.
	 */
	permissions: z.array(zPermission),
	/** The grants the mode in use still lacks. */
	missing: z.array(z.string()),
	cursor: zComputerCursor,
});
export type ComputerStatus = z.infer<typeof zComputerStatus>;

export const zComputerInstallResult = zInstallResult;
