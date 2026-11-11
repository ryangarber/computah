/**
 * computah: typed browser, terminal and computer use.
 *
 * Three controllers with one grammar. Each is made with a `create…` function
 * and answers the same questions the same way: `status()` (what was found and
 * whether it is enough), `install()` (fetch what is missing), `permissions()`
 * and `requestPermissions()` (what the OS still has to allow), `run()` (steps,
 * in order, stopping at the first that fails) and `close()`.
 */
export * from "./browser.ts";
export * from "./computer.ts";
export * from "./core/grammar.ts";
export { type Chord, Keys } from "./core/keys.ts";
export type { Exec, ExecOptions, ExecResult } from "./core/process.ts";
export { type Frame, Frames, StepError } from "./core/run.ts";
export {
	Selector,
	type SelectorAttribute,
	type SelectorPart,
	type SelectorValue,
} from "./core/selector.ts";
export * from "./terminal.ts";
