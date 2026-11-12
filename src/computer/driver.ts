import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, InstallOptions, InstallResult } from "../core/grammar.ts";
import {
	exec as defaultExec,
	download,
	type Exec,
	Paths,
} from "../core/process.ts";
import { errorMessage, sleep } from "../core/run.ts";
import type { ComputerMode } from "./schema.ts";

/** The `@trycua/cua-driver` module, as loaded or as a consumer passed it in. */
export type DriverSdk = typeof import("@trycua/cua-driver");
/** A driver as the SDK hands one out, however it was made. */
export type DriverInstance = ReturnType<DriverSdk["CuaDriver"]["connect"]>;

/**
 * Which driver to use.
 * - `auto` (default): the Cua Driver app's service where it is installed,
 *   reachable and permitted (it draws the virtual cursor), else in-process.
 * - `in-process` / `app`: that one, or fail.
 * - `{ binaryPath }`: start that `cua-driver` as a child of this process, so
 *   it runs under the host's own permissions and still draws the cursor.
 * - `{ socketPath }`: a driver service already listening there.
 * - `{ instance }`: a driver the consumer made with the SDK.
 */
export type DriverChoice =
	| "auto"
	| "in-process"
	| "app"
	| {
			binaryPath: string;
			bundleId?: string;
			environment?: Record<string, string>;
	  }
	| { socketPath: string }
	| { instance: DriverInstance };

/** What a driver tool answered, whatever it was. */
export interface ToolOutput {
	text: string;
	/** Its structured result, or an empty object where it had none. */
	data: Record<string, unknown>;
	images: Image[];
	isError: boolean;
	/** The driver's own code for a refusal: `stale_element_token`, … */
	code?: string;
}

export interface DriverHandle {
	mode: ComputerMode;
	call: (
		name: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<ToolOutput>;
	close: () => Promise<void>;
}

const APP_NAME = "CuaDriver";
const INSTALLER = "https://cua.ai/driver/install.sh";
const INSTALLER_WINDOWS = "https://cua.ai/driver/install.ps1";

/**
 * Where `install.ps1` puts `cua-driver.exe`: its bin directory on the user's
 * PATH (a junction to the active release), the release junction under its
 * package home, and the older `trycua` layout. PATH itself is read
 * when this process started, so a driver installed since is only found here.
 */
const windowsPaths = (home: string) => {
	const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
	const packages = process.env.CUA_DRIVER_RS_HOME ?? join(home, ".cua-driver");
	return [
		process.env.CUA_DRIVER_RS_INSTALL_DIR &&
			join(process.env.CUA_DRIVER_RS_INSTALL_DIR, "cua-driver.exe"),
		join(local, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
		join(packages, "packages", "current", "cua-driver.exe"),
		join(local, "Programs", "trycua", "cua-driver-rs", "bin", "cua-driver.exe"),
	];
};

/**
 * The `cua-driver` binaries started for this process, by process id. Each
 * should end once this process does (it watches a pipe from it), but on macOS
 * 0.46.1 stops serving and then waits on its cursor overlay forever, outliving
 * the host. So they are killed outright: SIGTERM does not end them either.
 */
const children = new Set<number>();

const kill = (pid: number) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	children.delete(pid);
};

const killChildren = () => {
	for (const pid of children) kill(pid);
};

let killOnExit = false;

const destroy = (object: unknown) => {
	try {
		(object as { uniffiDestroy?: () => void }).uniffiDestroy?.();
	} catch {}
};

const parse = (json: string | undefined): Record<string, unknown> => {
	if (!json) return {};
	try {
		const value: unknown = JSON.parse(json);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

/** A driver's errors carry their detail in more than one place. */
const describe = (error: unknown) => {
	const inner = (error as { inner?: unknown })?.inner;
	if (inner && typeof inner === "object") {
		const message = (inner as { message?: unknown }).message;
		if (typeof message === "string" && message) return message;
		const [first] = Object.values(inner);
		if (typeof first === "string" && first) return first;
	}
	return errorMessage(error);
};

const wrap = (
	instance: DriverInstance,
	mode: ComputerMode,
	{
		session,
		owned,
		onClose,
	}: { session?: string; owned: boolean; onClose?: () => Promise<void> },
): DriverHandle => ({
	mode,
	call: async (name, args = {}, signal) => {
		signal?.throwIfAborted();
		try {
			const result = await instance.callTool(
				name,
				JSON.stringify(session ? { session, ...args } : args),
				signal ? { signal } : undefined,
			);
			return {
				text: result.text,
				data: parse(result.structuredJson),
				images: result.images.map((image) => ({
					mime: image.mimeType,
					data: image.dataBase64,
				})),
				isError: result.isError,
				...(result.errorCode ? { code: result.errorCode } : {}),
			};
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			return { text: describe(error), data: {}, images: [], isError: true };
		}
	},
	close: async () => {
		if (owned) {
			// Ends the run's session, and with it the cursor it drew.
			await instance
				.callTool("end_session", JSON.stringify(session ? { session } : {}))
				.catch(() => {});
			await instance.shutdown().catch(() => {});
			destroy(instance);
		}
		await onClose?.();
	},
});

export const Driver = {
	/** The SDK, or why it cannot be loaded here (no native library for this platform, say). */
	load: async (
		sdk?: DriverSdk,
	): Promise<{ sdk?: DriverSdk; error?: string }> => {
		if (sdk) return { sdk };
		try {
			return { sdk: await import("@trycua/cua-driver") };
		} catch (error) {
			return { error: describe(error) };
		}
	},

	/**
	 * The Cua Driver app and its command line, wherever they were installed.
	 * Nothing is run to find them.
	 */
	discover: ({
		app,
		cli,
	}: {
		app?: string;
		cli?: string;
	} = {}): { app?: string; cli?: string; version?: string } => {
		const home = homedir();
		const bundle =
			app ??
			(process.platform === "darwin"
				? [
						`/Applications/${APP_NAME}.app`,
						join(home, "Applications", `${APP_NAME}.app`),
					].find(Paths.exists)
				: undefined);
		const executable =
			cli ??
			[
				process.env.CUA_DRIVER_PATH,
				Paths.which("cua-driver", Paths.common()),
				bundle && join(bundle, "Contents", "MacOS", "cua-driver"),
				...(process.platform === "win32" ? windowsPaths(home) : []),
			].find((file): file is string => !!file && Paths.isExecutable(file));

		let version: string | undefined;
		if (bundle) {
			try {
				version =
					/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(
						readFileSync(join(bundle, "Contents", "Info.plist"), "utf8"),
					)?.[1];
			} catch {}
		}
		return {
			...(bundle ? { app: bundle } : {}),
			...(executable ? { cli: executable } : {}),
			...(version ? { version } : {}),
		};
	},

	/** A driver inside this process, under this process's own permissions. */
	inProcess: (sdk: DriverSdk, session?: string): DriverHandle =>
		wrap(
			// `embedded` keeps the SDK from looking for the app's service itself.
			sdk.CuaDriver.create({ embedded: true, claudeCodeCompatibility: false }),
			"in-process",
			{ session, owned: true },
		),

	/**
	 * The Cua Driver app's service, started if it is installed and not yet
	 * running. Undefined where it cannot be reached.
	 */
	app: async ({
		sdk,
		app,
		session,
		launch = true,
		timeout = 15_000,
		signal,
	}: {
		sdk: DriverSdk;
		app?: string;
		session?: string;
		launch?: boolean;
		timeout?: number;
		signal?: AbortSignal;
	}): Promise<DriverHandle | undefined> => {
		const instance = sdk.CuaDriver.connect(undefined);
		const handle = () => wrap(instance, "app", { session, owned: true });
		if (instance.isAvailable()) return handle();
		if (launch && app && process.platform === "darwin") {
			// Through LaunchServices, so the service runs as the app and under
			// the app's own permissions rather than this process's.
			const opened = await new Promise<boolean>((resolve) => {
				const child = spawn(
					"/usr/bin/open",
					["-n", "-g", "-a", app, "--args", "serve"],
					{ stdio: "ignore" },
				);
				child.on("error", () => resolve(false));
				child.on("close", (code) => resolve(code === 0));
			});
			const deadline = Date.now() + timeout;
			while (opened && Date.now() < deadline) {
				if (instance.isAvailable()) return handle();
				await sleep(250, signal);
			}
		}
		destroy(instance);
		return undefined;
	},

	/**
	 * A `cua-driver` binary run as this process's child: the host's own
	 * permissions apply to it, and it can still draw the virtual cursor.
	 */
	embedded: async ({
		sdk,
		binaryPath,
		bundleId = "",
		environment = {},
		session,
	}: {
		sdk: DriverSdk;
		binaryPath: string;
		bundleId?: string;
		environment?: Record<string, string>;
		session?: string;
	}): Promise<DriverHandle> => {
		const host = sdk.EmbeddedCuaDriverHost.withOptions(
			sdk.EmbeddedDriverHostOptions.create({
				binaryPath,
				hostBundleId: bundleId,
				approveCapabilityManifest: false,
				approveSessionPolicy: false,
				dangerouslyBypassApprovals: false,
				environment: Object.entries(environment).map(([name, value]) => ({
					name,
					value,
				})),
				inheritStderr: false,
				noOverlay: false,
				captureStderr: true,
			}),
		);
		try {
			const connection = await host.start();
			children.add(connection.pid);
			if (!killOnExit) {
				killOnExit = true;
				process.once("exit", killChildren);
			}
			return wrap(sdk.CuaDriver.connect(connection.socketPath), "embedded", {
				session,
				owned: true,
				onClose: async () => {
					await host.stop().catch(() => {});
					destroy(host);
					kill(connection.pid);
				},
			});
		} catch (error) {
			const detail = host.lastDiagnostics()?.stderrTail.trim();
			const pid = host.connection()?.pid;
			await host.stop().catch(() => {});
			if (pid) kill(pid);
			destroy(host);
			throw new Error(
				`The driver at ${binaryPath} could not be started: ${describe(error)}${detail ? `\n${detail.slice(-1_000)}` : ""}`,
			);
		}
	},

	/**
	 * Ends every `cua-driver` started by {@link Driver.embedded} at once, and
	 * synchronously, for a host about to exit some way Node's `exit` event
	 * does not see (a native quit, say). Plain exits already do this.
	 */
	killEmbedded: () => killChildren(),

	/** A driver made elsewhere: left running when this one is closed. */
	external: (
		sdk: DriverSdk,
		choice: { socketPath: string } | { instance: DriverInstance },
		session?: string,
	): DriverHandle =>
		"instance" in choice
			? wrap(choice.instance, "external", { session, owned: false })
			: wrap(sdk.CuaDriver.connect(choice.socketPath), "external", {
					session,
					owned: true,
				}),

	/**
	 * The host's own grants, read without asking for any. Only macOS gates
	 * these behind permissions; elsewhere there is nothing to grant.
	 */
	hostPermissions: (sdk: DriverSdk) => {
		if (process.platform !== "darwin") {
			return { accessibility: true, screenRecording: true };
		}
		return sdk.currentMacOsPermissionStatus();
	},

	/**
	 * Raises macOS's prompts for whichever of the host's grants are missing.
	 * They name the app this process belongs to (a terminal, for a CLI), and
	 * a grant made while the process runs only counts once it is restarted.
	 */
	requestHostPermissions: (
		sdk: DriverSdk,
		{ settings = false }: { settings?: boolean } = {},
	) => {
		if (process.platform !== "darwin") {
			return { accessibility: true, screenRecording: true };
		}
		const status = sdk.requestMacOsPermissions();
		// Some macOS releases will not raise the Screen Recording prompt, and
		// none raise it twice: the settings pane is the way in then.
		if (settings && !status.screenRecording) {
			try {
				sdk.openMacOsScreenRecordingSettings();
			} catch {}
		}
		return status;
	},

	/** A driver's own view of its grants: the app's, for the app's service. */
	permissions: async (handle: DriverHandle, signal?: AbortSignal) => {
		const { data, isError } = await handle.call(
			"check_permissions",
			{ prompt: false },
			signal,
		);
		if (isError) return undefined;
		return {
			accessibility: data.accessibility === true,
			screenRecording: data.screen_recording === true,
		};
	},

	/**
	 * Has the Cua Driver app ask for its own grants: through its service
	 * where that agrees to, else by running its `permissions grant`, which
	 * opens its guide and waits there for the user.
	 */
	requestAppPermissions: async ({
		handle,
		cli,
	}: {
		handle?: DriverHandle;
		cli?: string;
	}): Promise<boolean> => {
		if (handle) {
			const { isError } = await handle.call("check_permissions", {
				prompt: true,
			});
			if (!isError) return true;
		}
		if (!cli) return false;
		return await new Promise<boolean>((resolve) => {
			const child = spawn(cli, ["permissions", "grant"], {
				stdio: "ignore",
				detached: true,
			});
			child.on("error", () => resolve(false));
			child.on("spawn", () => {
				child.unref();
				resolve(true);
			});
		});
	},

	/**
	 * Installs the Cua Driver app with its publisher's installer, pinned to
	 * the version this SDK speaks to. The installer is asked for nothing but
	 * the app: no agent configuration, no shell profile edits, no self-test.
	 */
	install: async ({
		version,
		exec = defaultExec,
		signal,
		onProgress,
	}: InstallOptions & {
		/** A release such as `0.46.1`, or `latest`. */
		version?: string;
		exec?: Exec;
	} = {}): Promise<InstallResult> => {
		const windows = process.platform === "win32";
		const dir = await mkdtemp(join(tmpdir(), "computah-driver-"));
		const script = join(dir, windows ? "install.ps1" : "install.sh");
		const command = windows
			? `irm ${INSTALLER_WINDOWS} | iex`
			: `/bin/bash -c "$(curl -fsSL ${INSTALLER})"`;
		try {
			await download({
				url: windows ? INSTALLER_WINDOWS : INSTALLER,
				file: script,
				signal,
				onProgress,
			});
			onProgress?.({ phase: "install", message: "Installing Cua Driver" });
			const result = await exec({
				program: windows ? "powershell.exe" : "/bin/bash",
				args: windows
					? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
					: [script, "--no-connect", "--no-test", "--no-modify-path"],
				env: {
					CUA_DRIVER_NO_CONNECT: "1",
					CUA_DRIVER_NO_TEST: "1",
					CUA_DRIVER_NO_MODIFY_PATH: "1",
					...(version && version !== "latest"
						? { CUA_DRIVER_RS_VERSION: version }
						: {}),
				},
				signal,
				onOutput: (chunk) =>
					onProgress?.({ phase: "install", message: chunk.trimEnd() }),
			});
			const output = `${result.stdout}${result.stderr}`.trim().slice(-4_000);
			const found = Driver.discover();
			const ok = result.code === 0 && !!(found.app ?? found.cli);
			return {
				ok,
				installed: ok
					? [`cua-driver${found.version ? `@${found.version}` : ""}`]
					: [],
				...(ok
					? {}
					: { error: "The Cua Driver installer did not finish.", command }),
				output,
			};
		} catch (error) {
			return { ok: false, installed: [], error: errorMessage(error), command };
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	},
} as const;
