import type { StepResult } from "./grammar.ts";

/** A step's failure that has something to show for itself besides its message. */
export class StepError extends Error {
	readonly value?: unknown;

	constructor(message: string, value?: unknown) {
		super(message);
		this.name = "StepError";
		this.value = value;
	}
}

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Runs steps in order, stopping at the first that fails or once aborted.
 * A step answers with its value; a thrown error becomes its result and ends
 * the run, with the steps after it counted as skipped.
 */
export const runSteps = async <Step extends { action: string }>({
	steps,
	execute,
	signal,
}: {
	steps: readonly Step[];
	execute: (step: Step, index: number) => Promise<unknown>;
	signal?: AbortSignal;
}): Promise<{ steps: StepResult[]; skipped: number }> => {
	const results: StepResult[] = [];
	let skipped = 0;
	for (const [index, step] of steps.entries()) {
		if (signal?.aborted) {
			skipped = steps.length - index;
			break;
		}
		try {
			const value = await execute(step, index);
			results.push({
				action: step.action,
				ok: true,
				...(value === undefined ? {} : { value }),
			});
		} catch (error) {
			if (signal?.aborted) {
				skipped = steps.length - index;
				break;
			}
			results.push({
				action: step.action,
				ok: false,
				error: errorMessage(error),
				...(error instanceof StepError && error.value !== undefined
					? { value: error.value }
					: {}),
			});
			skipped = steps.length - index - 1;
			break;
		}
	}
	return { steps: results, skipped };
};

/**
 * Where a point given in a screenshot's pixels is on the thing that was
 * captured. Each surface keeps the frame of its latest screenshot, so `x`/`y`
 * always mean "in the image you last saw", however it was scaled or cropped.
 */
export interface Frame {
	/** Image pixels per unit of the surface. */
	scale: number;
	/** The surface coordinate of the image's top-left corner. */
	x: number;
	y: number;
}

export const Frames = {
	identity: { scale: 1, x: 0, y: 0 } satisfies Frame as Frame,

	/** The scale that brings a size's long edge down to `max`, never up. */
	fit: (width: number, height: number, max?: number) =>
		max && Math.max(width, height) > max ? max / Math.max(width, height) : 1,

	/** An image point as a point on the surface. */
	toSurface: (frame: Frame, point: { x: number; y: number }) => ({
		x: frame.x + point.x / frame.scale,
		y: frame.y + point.y / frame.scale,
	}),

	/** A surface point as a point in the image. */
	toImage: (frame: Frame, point: { x: number; y: number }) => ({
		x: Math.round((point.x - frame.x) * frame.scale),
		y: Math.round((point.y - frame.y) * frame.scale),
	}),
} as const;
