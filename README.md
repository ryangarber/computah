# computah

Typed browser, terminal and computer use, with one grammar of steps.

```ts
import { createBrowser, createComputer, createTerminal } from "computah";
```

| Surface  | Runs on                             | Entry               |
| -------- | ----------------------------------- | ------------------- |
| Browser  | Playwright, in a Node child process | `computah/browser`  |
| Terminal | tmux sessions                       | `computah/terminal` |
| Computer | Cua Driver (`@trycua/cua-driver`)   | `computah/computer` |
| Schemas  | Zod only, nothing from Node         | `computah/schema`   |

## One shape

Every controller answers the same questions the same way:

```ts
const computer = createComputer();

await computer.status(); // what was found, whether it is enough, what is missing
await computer.install(); // download and install what is missing
await computer.permissions(); // OS grants, without asking
await computer.requestPermissions(); // raise the OS prompts
await computer.run({ steps }); // steps in order, stopping at the first that fails
await computer.close();
```

A run answers `{ steps: [{ action, ok, value?, error? }], skipped?, notice? }`
plus what its surface adds (`screenshots`, `screens`, `window`, `url`).

## One grammar

Steps are objects told apart by `action`, defined as Zod schemas
(`zBrowserStep`, `zTerminalStep`, `zComputerStep`). The actions they share
take the same fields everywhere:

```ts
{ action: "click", selector: 'role=button[name="Save"]', button: "right", count: 2, modifiers: ["Mod"] }
{ action: "drag", selector: "text=Card", to: { x: 400, y: 200 } }
{ action: "type", text: "hello", selector: "role=textbox", submit: true }
{ action: "press", keys: "Mod+A Backspace" }
{ action: "scroll", dy: 5 }
{ action: "wait", selector: "text=Done", gone: true, timeout: 5000 }
{ action: "hover", ref: "e12" }
```

- **Targets** are a `ref` from a `read`, a `selector`, or a point. Points are
  `x`/`y` in the pixels of the latest screenshot (pages and windows) or
  `row`/`col` cells (terminals).
- **Selectors** are Playwright's: `text=Save`, `text="Save"` (exact),
  `text=/sav(e|ing)/i`, `role=button[name="Save"]`, `id=submit`, chained with
  `>>`, picked with `nth=`. A page hands them to Playwright; a window matches
  them against its accessibility tree; a terminal matches text and style:
  `"ERR"[fg=red][bold]`, `[bg=blue][row=3]`.
- **Scaling**: screenshots take `maxDimension`, `format` and `quality`. Points
  are always in the pixels of the image that came back, and are mapped to the
  surface for you.
- **Keys** are space-separated chords. `Mod` is Command on macOS and Control
  elsewhere.

## Browser

```ts
const browser = createBrowser({ headless: false });
const { screenshots } = await browser.run({
	steps: [
		{ action: "navigate", url: "localhost:5173" },
		{ action: "click", selector: "text=Sign in" },
		{ action: "read" },
	],
	screenshot: true,
});
```

Found, in order, unless passed in (`runtime`, `playwright`, `executablePath`):
a Node to run the driver in; Playwright (computah's own `playwright-core`, one
it downloaded, the project's, a global one); a Chromium-based browser
(Playwright's, then Chrome, Edge, Brave). `install()` downloads
`playwright-core` and Chromium, whichever is missing. Sign-ins live in a
profile of its own under `~/.computah/browser`.

## Terminal

```ts
const terminal = createTerminal();
await terminal.run({
	steps: [
		{ action: "open", command: "pnpm dev:cli" },
		{ action: "wait", selector: "text=ready" },
		{ action: "press", keys: "Alt+Enter" },
	],
	capture: true,
});
```

tmux is found on `PATH` and in the usual places, or passed in (`tmux`).
`install()` uses the system's package manager, and hands back the command
when it needs a password. Pass `exec` to run tmux somewhere else (WSL, SSH),
`socket` for a tmux server of its own, and `marker`/`prefix` to keep sessions
opened under another name recognisable.

## Computer

```ts
const computer = createComputer({ session: "My App" });
await computer.run({
	steps: [
		{ action: "open", app: "Calculator" },
		{ action: "click", selector: 'role=button[name="7"]' },
	],
	screenshot: true,
});
```

Input is delivered **in the background**: nothing is raised, and the user's
pointer and focus are left alone. `foreground: true` on a step is the explicit
way out for the few surfaces that only take real input.

How the driver runs (`driver` option, reported as `status().mode`):

| Mode         | Permissions belong to | Virtual cursor | Needs                        |
| ------------ | --------------------- | -------------- | ---------------------------- |
| `in-process` | the host app          | no (macOS)     | nothing                      |
| `app`        | Cua Driver.app        | yes            | the app, installed           |
| `embedded`   | the host app          | yes            | a `cua-driver` binary's path |
| `external`   | whoever runs it       | as it has      | a socket or SDK instance     |

`auto`, the default, uses the app's service when it is installed, reachable
and permitted, and the in-process driver otherwise. So the usual flow is:

```ts
let status = await computer.status();
if (status.missing.length) await computer.requestPermissions(); // the host's own prompts

if (!status.cursor.available && status.cursor.reason === "not-installed") {
	await computer.install(); // Cua Driver.app
	await computer.requestPermissions({ owner: "app" }); // its prompts
}
status = await computer.status({ refresh: true });
```

macOS caches a process's grants, so a grant made while the host runs counts
once the host is restarted.
