import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { InstallProgress } from "./grammar.ts";

export interface ExecResult {
	/** The exit status; -1 where the program could not be started. */
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	program: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	/** Called with output as it comes, for progress. */
	onOutput?: (chunk: string) => void;
}

/**
 * Runs a program to completion. Every surface takes one of these, so a
 * consumer whose programs live somewhere else (inside WSL, over SSH, behind
 * its own sandbox) can pass its own and have tmux or an installer run there.
 */
export type Exec = (options: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = ({
	program,
	args = [],
	cwd,
	env,
	signal,
	onOutput,
}) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(program, args, {
				cwd,
				env: env ? { ...process.env, ...env } : process.env,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolve({ code: -1, stdout, stderr: String(error) });
			return;
		}
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			onOutput?.(chunk);
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
			onOutput?.(chunk);
		});
		child.on("error", (error) =>
			resolve({ code: -1, stdout, stderr: stderr || String(error) }),
		);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});

const isExecutable = (file: string) => {
	try {
		if (!statSync(file).isFile()) return false;
		if (process.platform !== "win32") accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

export const Paths = {
	home: () => homedir(),

	/** Where computah keeps what it downloads and the profiles it owns. */
	data: (override?: string) =>
		override ?? process.env.COMPUTAH_HOME ?? join(homedir(), ".computah"),

	exists: (file: string) => {
		try {
			return existsSync(file);
		} catch {
			return false;
		}
	},

	isExecutable,

	/**
	 * A program by name: on PATH first, then in the directories given. A GUI
	 * app's PATH is rarely the user's own, so the usual places are worth
	 * naming.
	 */
	which: (name: string, extra: string[] = []): string | undefined => {
		const names =
			process.platform === "win32"
				? [name, `${name}.exe`, `${name}.cmd`]
				: [name];
		const dirs = [
			...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
			...extra,
		];
		for (const dir of dirs) {
			for (const candidate of names) {
				const file = join(dir, candidate);
				if (isExecutable(file)) return file;
			}
		}
		return undefined;
	},

	/** Places programs are installed that a GUI app's PATH tends to miss. */
	common: () =>
		process.platform === "win32"
			? []
			: [
					"/opt/homebrew/bin",
					"/usr/local/bin",
					"/usr/bin",
					"/bin",
					"/snap/bin",
					join(homedir(), ".local", "bin"),
				],
} as const;

/**
 * A program as the user's own terminal would find it: through a login shell,
 * which knows about nvm, Homebrew and whatever else their profile sets up.
 */
export const whichInShell = async (
	name: string,
	run: Exec = exec,
): Promise<string | undefined> => {
	if (process.platform === "win32") {
		const { stdout } = await run({ program: "where.exe", args: [name] });
		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => /^[A-Za-z]:\\/.test(line));
	}
	const shell = process.env.SHELL || "/bin/sh";
	for (const flag of ["-lc", "-ic"]) {
		const { stdout } = await run({
			program: shell,
			args: [flag, `command -v ${name}`],
		});
		// The last path printed: an interactive shell may print other things first.
		const found = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("/"))
			.at(-1);
		if (found && isExecutable(found)) return found;
	}
	return undefined;
};

/** Downloads a URL to a file, optionally checking it against an SRI hash. */
export const download = async ({
	url,
	file,
	integrity,
	signal,
	onProgress,
}: {
	url: string;
	file: string;
	/** `sha512-…` or `sha256-…`, base64, as npm publishes them. */
	integrity?: string;
	signal?: AbortSignal;
	onProgress?: (progress: InstallProgress) => void;
}) => {
	const response = await fetch(url, { signal, redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${url}: HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length")) || undefined;
	const chunks: Uint8Array[] = [];
	let received = 0;
	for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
		chunks.push(chunk);
		received += chunk.byteLength;
		onProgress?.({
			phase: "download",
			message: `Downloading ${url}`,
			received,
			total,
		});
	}
	const data = Buffer.concat(chunks);
	if (integrity) {
		const [algorithm = "", expected = ""] = integrity.split(/-(.*)/s);
		const actual = createHash(algorithm).update(data).digest("base64");
		if (actual !== expected) {
			throw new Error(`${url} does not match its published ${algorithm} hash`);
		}
	}
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, data);
	return file;
};
