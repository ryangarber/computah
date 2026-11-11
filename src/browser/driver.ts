/** biome-ignore-all lint/suspicious/noExplicitAny: the driver is untyped Node and page script */
/** biome-ignore-all lint/complexity/useArrowFunction: sent as source */
/** biome-ignore-all lint/performance/useDomNodeTextContent: reads rendered text */

/**
 * The browser driver: a small Node program that owns Playwright and answers
 * JSON-RPC over stdio, one message per line. It is started with `node -e`, so
 * whatever hosts computah (Node, Bun, a desktop shell) drives a browser the
 * same way, and Playwright runs in the runtime it is written for.
 *
 * It travels as source (`driver.toString()`), so it must not close over
 * anything in this module, imports included. `require` and `process` come in as
 * arguments, out of reach of bundlers that rewrite those names. The functions
 * it hands to `page.evaluate` run in the page, not in Node.
 */
function driver(load: any, proc: any) {
	const fs = load("node:fs");
	const path = load("node:path");
	const readline = load("node:readline");

	// stdout carries the protocol and nothing else; stderr may never be
	// drained, so a chatty dependency would eventually block on it.
	const out = proc.stdout.write.bind(proc.stdout);
	const quiet = () => true;
	proc.stdout.write = quiet;
	proc.stderr.write = quiet;
	for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
		(console as any)[level] = () => {};
	}
	const send = (message: any) => out(`${JSON.stringify(message)}\n`);

	const exists = (file: string) => {
		try {
			return fs.existsSync(file);
		} catch {
			return false;
		}
	};
	const clean = (error: any) =>
		(String(error?.message ?? error).split("\nCall log:")[0] ?? "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes
			.replace(/\u001b\[[0-9;]*m/g, "")
			.trim()
			.slice(0, 1_000);

	// --- display ------------------------------------------------------------

	/**
	 * Why a headed launch failed for want of somewhere to draw, learned from
	 * the first one that did; a recheck starts a new driver, which tries again.
	 */
	let headedFailure: string | undefined;

	/** A launch error that means there is no usable display, not a broken browser. */
	const isDisplayError = (error: any) =>
		/XServer|X server|\$DISPLAY|cannot open display|Missing X|wayland|ozone|Failed to connect to (?:the )?(?:X|display|Wayland)|headed browser|no display/i.test(
			clean(error),
		);

	/**
	 * Whether a browser window can be shown here. macOS and Windows always
	 * have a desktop; on Linux (WSLg included) it takes an X or Wayland
	 * display whose socket is actually there.
	 */
	const display = (): { available: boolean; error?: string } => {
		if (headedFailure) return { available: false, error: headedFailure };
		if (proc.platform !== "linux") return { available: true };

		const env = proc.env;
		const wayland = env.WAYLAND_DISPLAY;
		if (wayland) {
			const socket = path.isAbsolute(wayland)
				? wayland
				: path.join(env.XDG_RUNTIME_DIR ?? "", wayland);
			if (exists(socket)) return { available: true };
		}
		const x = env.DISPLAY;
		if (x) {
			const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(x);
			// A display on another host is reached over the network; trust it.
			if (!local || exists(`/tmp/.X11-unix/X${local[1]}`)) {
				return { available: true };
			}
		}
		return {
			available: false,
			error:
				!x && !wayland
					? "No desktop to show it on ($DISPLAY and $WAYLAND_DISPLAY are unset)"
					: `The desktop is not reachable (${[x && `DISPLAY=${x}`, wayland && `WAYLAND_DISPLAY=${wayland}`].filter(Boolean).join(", ")} has no socket)`,
		};
	};

	// --- page scripts (run in the browser) ---------------------------------

	/**
	 * The page as an indented outline of what a person would see and use:
	 * landmarks, headings, text, and controls with refs to act on. Wrappers
	 * that only lay things out are flattened away, and text inside a control
	 * becomes its name. Refs stay with their element until it leaves the DOM.
	 */
	const snapshot = function (root: any) {
		const w: any = globalThis;
		const document = w.document;
		w.__computah ??= { els: new Map(), ids: new WeakMap(), next: 0 };
		const state = w.__computah;
		for (const [ref, el] of state.els) {
			if (!el.isConnected) state.els.delete(ref);
		}
		const refOf = (el: any) => {
			let ref = state.ids.get(el);
			if (!ref) {
				ref = `e${++state.next}`;
				state.ids.set(el, ref);
			}
			state.els.set(ref, el);
			return ref;
		};

		const SKIP = new Set([
			"SCRIPT",
			"STYLE",
			"NOSCRIPT",
			"TEMPLATE",
			"HEAD",
			"META",
			"LINK",
		]);
		const INTERACTIVE = new Set([
			"link",
			"button",
			"checkbox",
			"radio",
			"switch",
			"slider",
			"textbox",
			"searchbox",
			"spinbutton",
			"combobox",
			"listbox",
			"option",
			"menuitem",
			"menuitemcheckbox",
			"menuitemradio",
			"tab",
			"treeitem",
		]);
		const FIELDS = new Set([
			"textbox",
			"searchbox",
			"spinbutton",
			"combobox",
			"listbox",
			"slider",
		]);
		const NAMED_BY_CONTENT = new Set([
			"link",
			"button",
			"heading",
			"tab",
			"menuitem",
			"menuitemcheckbox",
			"menuitemradio",
			"option",
			"treeitem",
			"checkbox",
			"radio",
			"switch",
			"cell",
			"columnheader",
		]);
		const INPUT_ROLES: Record<string, string> = {
			checkbox: "checkbox",
			radio: "radio",
			range: "slider",
			button: "button",
			submit: "button",
			reset: "button",
			image: "button",
			file: "button",
			search: "searchbox",
			number: "spinbutton",
			hidden: "",
		};
		const TAG_ROLES: Record<string, string> = {
			BUTTON: "button",
			SUMMARY: "button",
			TEXTAREA: "textbox",
			H1: "heading",
			H2: "heading",
			H3: "heading",
			H4: "heading",
			H5: "heading",
			H6: "heading",
			UL: "list",
			OL: "list",
			LI: "listitem",
			NAV: "navigation",
			MAIN: "main",
			HEADER: "banner",
			FOOTER: "contentinfo",
			ASIDE: "complementary",
			FORM: "form",
			DIALOG: "dialog",
			TABLE: "table",
			TR: "row",
			TH: "columnheader",
			TD: "cell",
			P: "paragraph",
			IFRAME: "iframe",
			VIDEO: "video",
			AUDIO: "audio",
			PRE: "code",
		};
		const getRole = (el: any) => {
			const explicit = el.getAttribute("role")?.split(/\s+/)[0];
			if (explicit) return explicit === "none" ? "presentation" : explicit;
			const tag = el.tagName;
			if (tag === "A") return el.hasAttribute("href") ? "link" : "";
			if (tag === "IMG") return el.getAttribute("alt") === "" ? "" : "img";
			if (tag === "SELECT")
				return el.multiple || el.size > 1 ? "listbox" : "combobox";
			if (tag === "INPUT") {
				const type = String(el.type || "text").toLowerCase();
				return INPUT_ROLES[type] ?? "textbox";
			}
			return TAG_ROLES[tag] ?? "";
		};
		const clip = (text: string, max: number) => {
			const value = String(text ?? "")
				.replace(/\s+/g, " ")
				.trim();
			return value.length > max ? `${value.slice(0, max - 1)}…` : value;
		};
		const getName = (el: any, role: string) => {
			const label = el.getAttribute("aria-label");
			if (label?.trim()) return clip(label, 100);
			const by = el.getAttribute("aria-labelledby");
			if (by) {
				const text = by
					.split(/\s+/)
					.map((id: string) => document.getElementById(id)?.innerText ?? "")
					.join(" ");
				if (text.trim()) return clip(text, 100);
			}
			if (el.labels?.length) {
				const text = [...el.labels]
					.map((label: any) => label.innerText)
					.join(" ");
				if (text.trim()) return clip(text, 100);
			}
			if (el.tagName === "IMG") return clip(el.alt ?? "", 100);
			if (el.tagName === "INPUT" && /^(submit|button|reset)$/.test(el.type)) {
				return clip(el.value, 100);
			}
			if (NAMED_BY_CONTENT.has(role)) {
				const text = clip(el.innerText ?? el.textContent ?? "", 100);
				if (text) return text;
			}
			return clip(
				el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "",
				100,
			);
		};
		const isVisible = (el: any, style: any) => {
			if (el.getAttribute("aria-hidden") === "true") return false;
			if (style.display === "contents") return true;
			if (style.visibility === "hidden" || style.visibility === "collapse")
				return false;
			if (el.checkVisibility) return el.checkVisibility();
			return style.display !== "none";
		};
		const getStyle = (el: any) => w.getComputedStyle(el);

		type Item =
			| { text: string }
			| { br: true }
			| {
					role: string;
					name: string;
					ref?: string;
					props: string[];
					children: Item[];
			  };

		const visit = (node: any): Item[] => {
			if (node.nodeType === 3) {
				return node.textContent.trim() ? [{ text: node.textContent }] : [];
			}
			if (node.nodeType !== 1 || SKIP.has(node.tagName)) return [];
			const el = node;
			const style = getStyle(el);
			if (!isVisible(el, style)) return [];

			let role = getRole(el);
			if (role === "presentation" || role === "generic") role = "";
			const pointer =
				style.cursor === "pointer" &&
				(!el.parentElement || getStyle(el.parentElement).cursor !== "pointer");
			const interactive =
				INTERACTIVE.has(role) ||
				(el.isContentEditable && !el.parentElement?.isContentEditable) ||
				el.hasAttribute("onclick") ||
				(el.hasAttribute("tabindex") && el.tabIndex >= 0) ||
				pointer;

			let children: Item[] = [];
			if (el.tagName === "SELECT") {
				children = [...el.options].slice(0, 25).map((option: any) => ({
					role: "option",
					name: clip(option.label, 80),
					props: option.selected ? ["selected"] : [],
					children: [],
				}));
			} else if (el.tagName !== "IFRAME") {
				const kids = el.shadowRoot
					? el.shadowRoot.childNodes
					: el.tagName === "SLOT" && el.assignedNodes().length
						? el.assignedNodes()
						: el.childNodes;
				for (const kid of kids) children.push(...visit(kid));
			}

			if (!role && !interactive) {
				// Layout only: its content joins the parent's, on its own line
				// unless it flows inline.
				const block = !String(style.display).startsWith("inline");
				return block ? [{ br: true }, ...children, { br: true }] : children;
			}

			const name = getName(el, role || "clickable");
			if (name && NAMED_BY_CONTENT.has(role)) {
				// the text is already the name
				children = children.filter((child) => !("text" in child));
			}

			const props: string[] = [];
			if (/^H[1-6]$/.test(el.tagName)) props.push(`level=${el.tagName[1]}`);
			if (role === "link" && el.getAttribute("href")) {
				const href = el.getAttribute("href");
				if (!href.startsWith("javascript:"))
					props.push(`href=${clip(href, 100)}`);
			}
			if (FIELDS.has(role) && el.tagName !== "SELECT" && "value" in el) {
				if (el.value) props.push(`value="${clip(el.value, 100)}"`);
				else if (el.placeholder && name !== el.placeholder)
					props.push(`placeholder="${clip(el.placeholder, 60)}"`);
			}
			if (el.type === "checkbox" || el.type === "radio") {
				if (el.checked) props.push("checked");
			} else if (el.getAttribute("aria-checked") === "true") {
				props.push("checked");
			}
			if (el.getAttribute("aria-expanded"))
				props.push(`expanded=${el.getAttribute("aria-expanded")}`);
			if (el.getAttribute("aria-selected") === "true") props.push("selected");
			if (el.disabled || el.getAttribute("aria-disabled") === "true")
				props.push("disabled");
			if (role === "iframe" && el.src) props.push(`src=${clip(el.src, 100)}`);

			return [
				{
					role: role || "clickable",
					name,
					ref: interactive ? refOf(el) : undefined,
					props,
					children,
				},
			];
		};

		const lines: string[] = [];
		const render = (items: Item[], depth: number) => {
			const pad = "  ".repeat(depth);
			let text = "";
			const flush = () => {
				const value = clip(text, 400);
				if (value) lines.push(`${pad}- text: ${value}`);
				text = "";
			};
			for (const item of items) {
				if ("text" in item) {
					text += item.text;
					continue;
				}
				flush();
				if ("br" in item) continue;
				let line = `${pad}- ${item.role}`;
				if (item.name) line += ` "${item.name.replace(/"/g, '\\"')}"`;
				for (const prop of item.props) line += ` [${prop}]`;
				if (item.ref) line += ` [ref=${item.ref}]`;
				const content = item.children.filter((child) => !("br" in child));
				if (content.length && content.every((child) => "text" in child)) {
					const value = clip(
						content.map((child) => (child as { text: string }).text).join(""),
						400,
					);
					lines.push(value ? `${line}: ${value}` : line);
				} else if (content.length) {
					lines.push(`${line}:`);
					render(item.children, depth + 1);
				} else {
					lines.push(line);
				}
			}
			flush();
		};

		render(visit(root ?? document.body ?? document.documentElement), 0);
		return lines.join("\n");
	};

	const getHtml = function (root: any) {
		const w: any = globalThis;
		const clone = (root ?? w.document.documentElement).cloneNode(true);
		for (const node of clone.querySelectorAll(
			"script, style, noscript, template, link[rel=stylesheet]",
		)) {
			node.remove();
		}
		return clone.outerHTML;
	};

	const getText = function (root: any) {
		const w: any = globalThis;
		return (root ?? w.document.body ?? w.document.documentElement).innerText;
	};

	/** The viewport in CSS pixels, and where it is scrolled to in the document. */
	const getViewport = function () {
		const w: any = globalThis;
		const el = w.document.documentElement;
		return {
			width: w.innerWidth,
			height: w.innerHeight,
			left: w.scrollX,
			top: w.scrollY,
			fullWidth: Math.max(el.scrollWidth, w.innerWidth),
			fullHeight: Math.max(el.scrollHeight, w.innerHeight),
		};
	};

	// --- session -------------------------------------------------------------

	type Log = { level: string; text: string };
	type Options = {
		playwright: string;
		executablePath: string;
		headless: boolean;
		userDataDir: string;
		viewport?: { width: number; height: number };
		args?: string[];
	};

	let session: {
		key: string;
		context: any;
		browser?: any;
		headless: boolean;
		viewport: { width: number; height: number };
		/** Whether tabs lay out at `viewport` rather than at the window's size. */
		fixed: boolean;
	} | null = null;
	let active: any = null;
	const logs = new WeakMap<any, Log[]>();
	/**
	 * How much each tab's latest viewport screenshot was scaled down by, so
	 * `x`/`y` given in its pixels land where they were seen.
	 */
	const scales = new WeakMap<any, number>();
	const aborted = new Set<any>();

	const track = (page: any) => {
		const entries: Log[] = [];
		logs.set(page, entries);
		const push = (entry: Log) => {
			entries.push({ level: entry.level, text: entry.text.slice(0, 2_000) });
			if (entries.length > 500) entries.shift();
		};
		page.on("console", (message: any) =>
			push({ level: message.type(), text: message.text() }),
		);
		page.on("pageerror", (error: any) =>
			push({ level: "error", text: String(error?.stack ?? error) }),
		);
		// A dialog left open blocks the page, so they are accepted and logged.
		page.on("dialog", (dialog: any) => {
			push({
				level: "info",
				text: `[${dialog.type()} dialog accepted] ${dialog.message()}`,
			});
			dialog.accept().catch(() => {});
		});
	};

	const close = async () => {
		const current = session;
		session = null;
		active = null;
		await current?.context.close().catch(() => {});
		await current?.browser?.close().catch(() => {});
	};

	const fallback = (why?: string) =>
		`The browser window could not be shown${why ? `: ${why}.` : "."} The browser is running headless instead; everything else works as usual.`;

	const launch = async (options: Options) => {
		const key = JSON.stringify([
			options.playwright,
			options.executablePath,
			options.headless,
			options.userDataDir,
		]);
		if (session?.key === key) return session;
		await close();

		const { chromium } = load(options.playwright);
		const launchOptions = {
			executablePath: options.executablePath,
			headless: options.headless,
			args: [
				"--no-first-run",
				"--no-default-browser-check",
				...(options.args ?? []),
			],
		};
		const viewport = options.viewport ?? { width: 1280, height: 800 };
		const contextOptions = {
			// A shown window lays out at its own size unless one was asked for.
			viewport: options.headless || options.viewport ? viewport : null,
		};

		let context: any;
		let browser: any;
		try {
			// its own profile, so sign-ins made in it last between sessions
			fs.mkdirSync(options.userDataDir, { recursive: true });
			context = await chromium.launchPersistentContext(options.userDataDir, {
				...launchOptions,
				...contextOptions,
			});
		} catch (error) {
			// The profile is held by another window (two hosts at once): fall
			// back to a fresh, throwaway one.
			if (!/ProcessSingleton|already in use|SingletonLock/i.test(clean(error)))
				throw error;
			browser = await chromium.launch(launchOptions);
			context = await browser.newContext(contextOptions);
		}

		context.setDefaultTimeout(10_000);
		context.setDefaultNavigationTimeout(30_000);
		const current = {
			key,
			context,
			browser,
			headless: options.headless,
			viewport,
			fixed: contextOptions.viewport !== null,
		};
		session = current;
		context.on("close", () => {
			if (session === current) {
				session = null;
				active = null;
			}
		});
		context.on("page", (page: any) => {
			track(page);
			active = page;
		});
		for (const page of context.pages()) track(page);
		active = context.pages().at(-1) ?? (await context.newPage());
		return current;
	};

	/**
	 * Launches the browser as asked, or headless where no window can be shown:
	 * a missing desktop is not a reason for a run to fail. Says why when it
	 * fell back.
	 */
	const ensure = async (options: Options): Promise<{ notice?: string }> => {
		if (!options.headless) {
			const shown = display();
			if (!shown.available) {
				await launch({ ...options, headless: true });
				return { notice: fallback(shown.error) };
			}
			try {
				await launch(options);
				return {};
			} catch (error) {
				if (!isDisplayError(error)) throw error;
				headedFailure = clean(error).split("\n")[0];
				await launch({ ...options, headless: true });
				return { notice: fallback(headedFailure) };
			}
		}
		await launch(options);
		return {};
	};

	const getPage = async () => {
		if (!session) throw new Error("The browser is not running");
		if (!active || active.isClosed()) {
			active =
				session.context.pages().at(-1) ?? (await session.context.newPage());
		}
		return active;
	};

	// --- steps ---------------------------------------------------------------

	const resolve = async (page: any, step: any) => {
		if (step.ref) {
			const handle = await page.evaluateHandle(
				(ref: string) => (globalThis as any).__computah?.els.get(ref) ?? null,
				step.ref,
			);
			const element = handle.asElement();
			if (!element) {
				throw new Error(
					`No element ${step.ref} on this page; read the page again for fresh refs`,
				);
			}
			return element;
		}
		if (step.selector) return page.locator(step.selector).first();
		return null;
	};

	/** Where a step points, in the viewport's CSS pixels. */
	const getPoint = async (page: any, step: any, target: any) => {
		if (target) {
			await target.scrollIntoViewIfNeeded();
			const box = await target.boundingBox();
			if (!box) throw new Error("The element has no box to point at");
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		}
		if (typeof step.x === "number" && typeof step.y === "number") {
			const scale = scales.get(page) ?? 1;
			return { x: step.x / scale, y: step.y / scale };
		}
		return null;
	};

	const truncate = (text: string, max: number) =>
		text.length > max
			? `${text.slice(0, max)}\n… ${text.length - max} more characters; read a narrower ref or selector, or raise maxLength`
			: text;

	const compile = (script: string) => {
		const source = script.trim();
		const candidates =
			/^(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(source)
				? [source]
				: [`async (el) => (${source}\n)`, `async (el) => {\n${source}\n}`];
		let failure: unknown;
		for (const candidate of candidates) {
			try {
				return new Function(`return (${candidate}\n)`)();
			} catch (error) {
				failure = error;
			}
		}
		throw failure;
	};

	/**
	 * Captures the viewport, the whole page or one element, scaled down to
	 * `maxDimension` where it is larger. A viewport capture also sets the
	 * scale later `x`/`y` are read in.
	 */
	const shoot = async (page: any, target: any, options: any = {}) => {
		const format = options.format === "png" ? "png" : "jpeg";
		const quality = format === "jpeg" ? (options.quality ?? 70) : undefined;
		const view = await page.evaluate(getViewport);

		let clip: { x: number; y: number; width: number; height: number };
		if (target) {
			await target.scrollIntoViewIfNeeded();
			const box = await target.boundingBox();
			if (!box) throw new Error("The element has no box to capture");
			const scrolled = await page.evaluate(getViewport);
			clip = {
				x: box.x + scrolled.left,
				y: box.y + scrolled.top,
				width: box.width,
				height: box.height,
			};
		} else if (options.fullPage) {
			clip = { x: 0, y: 0, width: view.fullWidth, height: view.fullHeight };
		} else {
			clip = {
				x: view.left,
				y: view.top,
				width: view.width,
				height: view.height,
			};
		}

		const long = Math.max(clip.width, clip.height);
		const scale =
			options.maxDimension && long > options.maxDimension
				? options.maxDimension / long
				: 1;

		let data: string;
		if (scale === 1) {
			const native = { type: format, quality, scale: "css" };
			const buffer = target
				? await target.screenshot(native)
				: await page.screenshot({ ...native, fullPage: !!options.fullPage });
			data = buffer.toString("base64");
		} else {
			// Playwright has no way to scale a capture down; the protocol does.
			const cdp = await page.context().newCDPSession(page);
			try {
				const result = await cdp.send("Page.captureScreenshot", {
					format,
					quality,
					clip: { ...clip, scale },
					captureBeyondViewport: !!target || !!options.fullPage,
				});
				data = result.data;
			} finally {
				await cdp.detach().catch(() => {});
			}
		}
		if (!target && !options.fullPage) scales.set(page, scale);
		return {
			mime: `image/${format}`,
			data,
			width: Math.round(clip.width * scale),
			height: Math.round(clip.height * scale),
		};
	};

	const steps: Record<string, (_: any) => Promise<unknown>> = {
		navigate: async ({ page, step }) => {
			const options = { waitUntil: "domcontentloaded" };
			let response: any;
			if (step.url === "back") response = await page.goBack(options);
			else if (step.url === "forward") response = await page.goForward(options);
			else if (step.url === "reload") response = await page.reload(options);
			else {
				const url = /^[a-z][a-z\d+.-]*:/i.test(step.url)
					? step.url
					: `${/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(step.url) ? "http" : "https"}://${step.url}`;
				response = await page.goto(url, options);
			}
			return response ? { status: response.status() } : undefined;
		},

		read: async ({ page, step }) => {
			const target = await resolve(page, step);
			const format = step.format ?? "tree";
			const fn =
				format === "text" ? getText : format === "html" ? getHtml : snapshot;
			const text: string = target
				? await target.evaluate(fn)
				: await page.evaluate(fn, null);
			return truncate(text ?? "", step.maxLength ?? 20_000);
		},

		click: async ({ page, step }) => {
			const target = await resolve(page, step);
			const options = {
				button: step.button,
				clickCount: step.count,
				modifiers: step.modifiers,
			};
			if (target) return void (await target.click(options));
			const point = await getPoint(page, step, null);
			if (!point) throw new Error("click needs a ref, selector, or x and y");
			for (const key of step.modifiers ?? []) await page.keyboard.down(key);
			try {
				await page.mouse.click(point.x, point.y, options);
			} finally {
				for (const key of step.modifiers ?? []) await page.keyboard.up(key);
			}
		},

		hover: async ({ page, step }) => {
			const target = await resolve(page, step);
			if (target) return void (await target.hover());
			const point = await getPoint(page, step, null);
			if (!point) throw new Error("hover needs a ref, selector, or x and y");
			await page.mouse.move(point.x, point.y);
		},

		drag: async ({ page, step }) => {
			const from = await getPoint(page, step, await resolve(page, step));
			if (!from) throw new Error("drag needs a ref, selector, or x and y");
			const to = await getPoint(
				page,
				step.to ?? {},
				await resolve(page, step.to ?? {}),
			);
			if (!to) throw new Error("drag needs somewhere to let go, in `to`");
			const button = step.button ?? "left";
			for (const key of step.modifiers ?? []) await page.keyboard.down(key);
			try {
				await page.mouse.move(from.x, from.y);
				await page.mouse.down({ button });
				// In steps, so what is dragged over sees the pointer cross it.
				await page.mouse.move(to.x, to.y, { steps: 12 });
				await page.mouse.up({ button });
			} finally {
				for (const key of step.modifiers ?? []) await page.keyboard.up(key);
			}
			const round = (p: { x: number; y: number }) => ({
				x: Math.round(p.x),
				y: Math.round(p.y),
			});
			return { from: round(from), to: round(to) };
		},

		type: async ({ page, step }) => {
			const target = await resolve(page, step);
			if (target) {
				const options: string[] | null = await target.evaluate((el: any) =>
					el.tagName === "SELECT"
						? [...el.options].map((o: any) => `${o.value}\n${o.label}`)
						: null,
				);
				if (options) {
					const match = options
						.map((option) => option.split("\n"))
						.find(
							([value, label]) => value === step.text || label === step.text,
						);
					if (!match) {
						throw new Error(
							`No option "${step.text}"; options are: ${options.map((o) => o.split("\n")[1]).join(", ")}`,
						);
					}
					await target.selectOption(match[0]);
				} else if (step.clear !== false) {
					await target.fill(step.text);
				} else {
					await target.focus();
					await page.keyboard.type(step.text);
				}
			} else {
				await page.keyboard.type(step.text);
			}
			if (step.submit) await page.keyboard.press("Enter");
		},

		press: async ({ page, step }) => {
			for (const key of String(step.keys).split(/\s+/).filter(Boolean)) {
				await page.keyboard.press(key);
			}
		},

		scroll: async ({ page, step }) => {
			const target = await resolve(page, step);
			if (target && step.dx === undefined && step.dy === undefined) {
				await target.scrollIntoViewIfNeeded();
			} else {
				const viewport = await page.evaluate(getViewport);
				const point = (await getPoint(page, step, target)) ?? {
					x: viewport.width / 2,
					y: viewport.height / 2,
				};
				await page.mouse.move(point.x, point.y);
				await page.mouse.wheel(step.dx ?? 0, step.dy ?? (step.dx ? 0 : 600));
				await page.waitForTimeout(150);
			}
			return await page.evaluate(() => ({
				scrollX: Math.round((globalThis as any).scrollX),
				scrollY: Math.round((globalThis as any).scrollY),
			}));
		},

		wait: async ({ page, step }) => {
			const timeout = Math.min(step.timeout ?? 10_000, 120_000);
			const state = step.state ?? (step.gone ? "hidden" : "visible");
			if (step.ref) {
				const target = await resolve(page, step);
				if (state === "visible" || state === "hidden") {
					await target.waitForElementState(state, { timeout });
				} else if (state === "detached") {
					await page.waitForFunction((el: any) => !el.isConnected, target, {
						timeout,
					});
				}
			} else if (step.selector) {
				await page.locator(step.selector).first().waitFor({ state, timeout });
			} else if (step.text) {
				await page.getByText(step.text).first().waitFor({ state, timeout });
			} else if (step.url) {
				await page.waitForURL(step.url, { timeout });
			} else if (step.script) {
				await page.waitForFunction(step.script, null, { timeout });
			} else if (step.load) {
				await page.waitForLoadState(step.load, { timeout });
			} else if (typeof step.ms === "number") {
				await page.waitForTimeout(Math.min(step.ms, 30_000));
			} else {
				throw new Error(
					"wait needs one of ms, ref, selector, text, url, script or load",
				);
			}
		},

		evaluate: async ({ page, step }) => {
			const target = await resolve(page, step);
			const fn = compile(step.script);
			const value = target
				? await target.evaluate(fn)
				: await page.evaluate(fn, null);
			const json = JSON.stringify(value ?? null) ?? "null";
			return json.length > 20_000 ? truncate(json, 20_000) : (value ?? null);
		},

		console: async ({ page, step }) => {
			const entries = logs.get(page) ?? [];
			const levels =
				step.level === "error"
					? ["error"]
					: step.level === "warning"
						? ["error", "warning"]
						: null;
			const selected = entries
				.filter((entry) => !levels || levels.includes(entry.level))
				.slice(-(step.limit ?? 50))
				.map((entry) => `[${entry.level}] ${entry.text}`);
			if (step.clear) entries.length = 0;
			return selected;
		},

		/**
		 * Sets the size the active tab lays out at. It stays with the tab, for
		 * every call after, until it is reset or the tab closes; tabs opened
		 * later start at the default.
		 */
		resize: async ({ page, step }) => {
			if (step.reset) {
				if (session?.fixed) {
					await page.setViewportSize(session.viewport);
				} else {
					// A shown window lays out at its own size once nothing overrides it.
					const cdp = await page.context().newCDPSession(page);
					try {
						await cdp.send("Emulation.clearDeviceMetricsOverride");
					} finally {
						await cdp.detach().catch(() => {});
					}
				}
			} else {
				const size = (value: unknown, name: string) => {
					if (typeof value !== "number" || !Number.isFinite(value)) {
						throw new Error(`resize needs a ${name}, or reset`);
					}
					return Math.min(Math.max(Math.round(value), 200), 4000);
				};
				await page.setViewportSize({
					width: size(step.width, "width"),
					height: size(step.height, "height"),
				});
			}
			// The latest screenshot no longer shows the page as it is laid out.
			scales.delete(page);
			const viewport = await page.evaluate(getViewport);
			return { width: viewport.width, height: viewport.height };
		},

		screenshot: async ({ page, step, screenshots, image }) => {
			const target = await resolve(page, step);
			const shot = await shoot(page, target, { ...image, ...step });
			screenshots.push(shot);
			return {
				screenshot: screenshots.length,
				width: shot.width,
				height: shot.height,
			};
		},

		tabs: async ({ step }) => {
			if (!session) throw new Error("The browser is not running");
			const context = session.context;
			const pick = (index: number) => {
				const page = context.pages()[index];
				if (!page) throw new Error(`No tab at index ${index}`);
				return page;
			};
			if (typeof step.close === "number") await pick(step.close).close();
			if (typeof step.open === "string") {
				const page = await context.newPage();
				active = page;
				await steps.navigate?.({ page, step: { url: step.open } });
			}
			if (typeof step.select === "number") {
				active = pick(step.select);
				await active.bringToFront();
			}
			return await listTabs();
		},
	};

	const listTabs = async () => {
		if (!session) return [];
		const page = active && !active.isClosed() ? active : null;
		return await Promise.all(
			session.context.pages().map(async (other: any, index: number) => ({
				index,
				url: other.url(),
				title: await other.title().catch(() => ""),
				active: other === page,
			})),
		);
	};

	const run = async (params: any, id: unknown) => {
		const { notice } = await ensure(params);
		const results: any[] = [];
		const screenshots: any[] = [];
		let skipped = 0;

		for (const [index, step] of params.steps.entries()) {
			if (aborted.has(id)) {
				skipped = params.steps.length - index;
				break;
			}
			const page = await getPage();
			try {
				const handler = steps[step.action];
				if (!handler) throw new Error(`Unknown action ${step.action}`);
				const value = await handler({
					page,
					step,
					screenshots,
					image: params.image,
				});
				results.push(
					value === undefined
						? { action: step.action, ok: true }
						: { action: step.action, ok: true, value },
				);
			} catch (error) {
				results.push({ action: step.action, ok: false, error: clean(error) });
				skipped = params.steps.length - index - 1;
				break;
			}
		}
		aborted.delete(id);

		const page = await getPage();
		if (params.screenshot) {
			try {
				screenshots.push(await shoot(page, null, params.image));
			} catch {}
		}
		return {
			url: page.url(),
			title: await page.title().catch(() => ""),
			steps: results,
			...(skipped ? { skipped } : {}),
			...(notice ? { notice } : {}),
			screenshots,
		};
	};

	// --- protocol ------------------------------------------------------------

	const methods: Record<string, (params: any, id: unknown) => Promise<any>> = {
		ping: async () => ({ node: proc.version, pid: proc.pid }),
		display: async () => display(),
		run,
		/**
		 * The open tabs. Never launches the browser: with none running there
		 * are none. Wrapped, as a JSON-RPC result has to be an object.
		 */
		listTabs: async () => ({ tabs: await listTabs() }),
		/** One tab's rendered text, leaving the active tab as it was. */
		readTab: async (params) => {
			if (!session) throw new Error("The browser is not running");
			const page = session.context.pages()[params.index];
			if (!page) throw new Error(`No tab at index ${params.index}`);
			const text: string = await page.evaluate(getText, null);
			return {
				url: page.url(),
				title: await page.title().catch(() => ""),
				text: truncate(text ?? "", params.maxLength ?? 20_000),
			};
		},
		close: async () => {
			await close();
			return {};
		},
	};

	// Runs share one page, so they go one at a time.
	let queue: Promise<unknown> = Promise.resolve();

	const shutdown = async () => {
		await close();
		proc.exit(0);
	};

	readline
		.createInterface({ input: proc.stdin })
		.on("line", (line: string) => {
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.method === "abort") {
				aborted.add(message.params?.id);
				return;
			}
			if (message.id === undefined) return;
			const method = methods[message.method];
			const task = async () => {
				try {
					if (!method) throw new Error(`Unknown method ${message.method}`);
					send({
						jsonrpc: "2.0",
						id: message.id,
						result: await method(message.params ?? {}, message.id),
					});
				} catch (error) {
					send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32000, message: clean(error) },
					});
				}
			};
			// Only reading, so not held up behind a run the agent is in.
			if (["ping", "display", "listTabs", "readTab"].includes(message.method))
				void task();
			else queue = queue.then(task);
		})
		// whoever started it went away
		.on("close", () => void shutdown());
	proc.on("SIGTERM", () => void shutdown());
}

/** The program for `node -e`. */
export const driverScript = `(${driver.toString()})(require, process);`;
