import { z } from "zod";

/**
 * The grammar every surface shares. A run is a list of steps, each an object
 * told apart by its `action`; steps run in order and the run stops at the
 * first that fails. The pieces here are the fields those steps are built
 * from, so a click reads the same whether it lands in a page, a terminal or a
 * native window.
 *
 * This module is schemas only: it imports nothing from Node, so it is safe in
 * a browser bundle that only needs the types.
 */

export const zButton = z.enum(["left", "right", "middle"]);
export type Button = z.infer<typeof zButton>;

/** `Mod` is Command on macOS and Control everywhere else. */
export const zModifier = z.enum(["Alt", "Control", "Meta", "Shift", "Mod"]);
export type Modifier = z.infer<typeof zModifier>;

/** A click's count: 2 for a double click. */
export const zCount = z
	.number()
	.int()
	.min(1)
	.max(3)
	.optional()
	.describe("2 for a double click.");

/** Keys pressed one after another, each optionally a chord. */
export const zKeys = (examples: string) =>
	z
		.string()
		.describe(
			`Keys to press in turn, space separated: ${examples}. \`Mod\` is Command on macOS and Control elsewhere.`,
		);

export const zTimeout = (fallback: number, max: number) =>
	z
		.number()
		.optional()
		.describe(
			`Milliseconds before giving up (default ${fallback}, max ${max}).`,
		);

/**
 * A Playwright-style selector. `engine=value` parts are chained with `>>`:
 * `text=Save`, `text="Save"` (exact), `text=/sav(e|ing)/i`,
 * `role=button[name="Save"]`, `id=submit`, `nth=1`. What each surface can
 * match on is said where it takes one.
 */
export const zSelector = (describe: string) =>
	z.string().optional().describe(describe);

/** A point in the pixels of the latest screenshot of the surface. */
export const zPoint = (space: string) => ({
	x: z.number().optional().describe(`x in ${space}.`),
	y: z.number().optional().describe(`y in ${space}.`),
});

/** How a captured image is sized and encoded. */
export const zImageOptions = {
	maxDimension: z
		.number()
		.int()
		.min(64)
		.max(8192)
		.optional()
		.describe(
			"Scale the image down so its long edge is at most this many pixels. Later x/y are in the scaled image's pixels and are mapped back.",
		),
	format: z.enum(["jpeg", "png"]).optional(),
	quality: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("JPEG quality (default 70)."),
};
export type ImageOptions = {
	maxDimension?: number;
	format?: "jpeg" | "png";
	quality?: number;
};

export const zImage = z.object({
	mime: z.string(),
	/** Base64. */
	data: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
});
export type Image = z.infer<typeof zImage>;

export const zStepResult = z.object({
	action: z.string(),
	ok: z.boolean(),
	value: z.unknown().optional(),
	error: z.string().optional(),
});
export type StepResult = z.infer<typeof zStepResult>;

/** What every run answers with, whatever else its surface adds. */
export const zRunResult = z.object({
	steps: z.array(zStepResult),
	/** Steps never reached because one before them failed or was aborted. */
	skipped: z.number().optional(),
	/**
	 * Something about how the run went that is not a failure: that a browser
	 * ran headless because no window could be shown, say.
	 */
	notice: z.string().optional(),
});

/** One thing a surface needs before it can run, found or not. */
export const zRequirement = z.object({
	name: z.string(),
	found: z.boolean(),
	path: z.string().optional(),
	version: z.string().optional(),
	/** Where it came from: `option`, `system`, `bundled`, `computah`… */
	source: z.string().optional(),
	/** Whether `install()` can put it there. */
	installable: z.boolean().optional(),
});
export type Requirement = z.infer<typeof zRequirement>;

/** An OS permission, and whether whoever needs it holds it. */
export const zPermission = z.object({
	/** `accessibility`, `screen-recording`. */
	name: z.string(),
	granted: z.boolean(),
	/** Whose grant it is: the app running this code, or a helper app. */
	owner: z.string(),
	/** Whether asking can still raise the system's prompt. */
	promptable: z.boolean().optional(),
});
export type Permission = z.infer<typeof zPermission>;

export const zInstallResult = z.object({
	ok: z.boolean(),
	/** What was installed, in order. */
	installed: z.array(z.string()),
	error: z.string().optional(),
	/** A command the user has to run themselves, where this could not. */
	command: z.string().optional(),
	output: z.string().optional(),
});
export type InstallResult = z.infer<typeof zInstallResult>;

export interface InstallProgress {
	/** `download`, `extract`, `install`, `verify`. */
	phase: string;
	message: string;
	received?: number;
	total?: number;
}

export interface InstallOptions {
	signal?: AbortSignal;
	onProgress?: (progress: InstallProgress) => void;
}
