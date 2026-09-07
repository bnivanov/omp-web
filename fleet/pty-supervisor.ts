/**
 * Generic process supervisor for non-OMP commands (test runners, builds).
 * Isolated from SDK daemons: piped stdio, byte-bounded output ring, REST+SSE.
 */

export interface PtySpawnOpts {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export type PtyStatus = "running" | "exited" | "killed" | "error";

export interface PtySnapshot {
	id: string;
	command: string;
	cwd?: string;
	status: PtyStatus;
	pid?: number;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	output: string;
	bytes: number;
}

interface PtyWorker {
	id: string;
	command: string;
	cwd?: string;
	status: PtyStatus;
	pid?: number;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	proc: ReturnType<typeof Bun.spawn>;
	chunks: string[];
	bytes: number;
	listeners: Set<(chunk: string) => void>;
}

const RING_BYTES = 512 * 1024;
const MAX_WORKERS = 32;

export class PtySupervisor {
	readonly #workers = new Map<string, PtyWorker>();
	#nextId = 1;

	spawn(opts: PtySpawnOpts): PtySnapshot {
		if (this.#workers.size >= MAX_WORKERS) {
			throw new Error(`pty cap reached (${MAX_WORKERS})`);
		}
		if (opts.command.length === 0) throw new Error("command must not be empty");
		const id = `pty${this.#nextId++}`;
		const argv =
			opts.args && opts.args.length > 0 ? [opts.command, ...opts.args] : ["sh", "-c", opts.command];
		const proc = Bun.spawn({
			cmd: argv,
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : undefined,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const worker: PtyWorker = {
			id,
			command:
				opts.args && opts.args.length > 0 ? [opts.command, ...opts.args].join(" ") : opts.command,
			cwd: opts.cwd,
			status: "running",
			pid: proc.pid,
			startedAt: Date.now(),
			proc,
			chunks: [],
			bytes: 0,
			listeners: new Set(),
		};
		this.#workers.set(id, worker);
		void this.#pump(worker, proc.stdout, "");
		void this.#pump(worker, proc.stderr, "");
		void proc.exited.then((code) => {
			worker.exitCode = code;
			worker.endedAt = Date.now();
			if (worker.status === "running") worker.status = code === 0 ? "exited" : "exited";
			this.#emit(worker, "");
		});
		return this.snapshot(id)!;
	}

	write(id: string, data: string): boolean {
		const worker = this.#workers.get(id);
		if (!worker || worker.status !== "running") return false;
		const stdin = worker.proc.stdin;
		if (typeof stdin === "number" || stdin === undefined) return false;
		stdin.write(data);
		return true;
	}

	kill(id: string): boolean {
		const worker = this.#workers.get(id);
		if (!worker) return false;
		if (worker.status === "running") {
			worker.status = "killed";
			worker.proc.kill();
			worker.endedAt = Date.now();
		}
		return true;
	}

	remove(id: string): boolean {
		const worker = this.#workers.get(id);
		if (!worker) return false;
		if (worker.status === "running") worker.proc.kill();
		this.#workers.delete(id);
		return true;
	}

	get(id: string): PtySnapshot | undefined {
		return this.snapshot(id);
	}

	list(): PtySnapshot[] {
		return [...this.#workers.keys()].map((id) => this.snapshot(id)!);
	}

	subscribe(id: string, fn: (chunk: string) => void): () => void {
		const worker = this.#workers.get(id);
		if (!worker) return () => {};
		worker.listeners.add(fn);
		return () => {
			worker.listeners.delete(fn);
		};
	}

	close(): void {
		for (const worker of this.#workers.values()) {
			if (worker.status === "running") worker.proc.kill();
		}
		this.#workers.clear();
	}

	snapshot(id: string): PtySnapshot | undefined {
		const worker = this.#workers.get(id);
		if (!worker) return undefined;
		return {
			id: worker.id,
			command: worker.command,
			cwd: worker.cwd,
			status: worker.status,
			pid: worker.pid,
			exitCode: worker.exitCode,
			startedAt: worker.startedAt,
			endedAt: worker.endedAt,
			output: worker.chunks.join(""),
			bytes: worker.bytes,
		};
	}

	async #pump(
		worker: PtyWorker,
		stream: ReadableStream<Uint8Array> | undefined,
		_prefix: string,
	): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			this.#append(worker, text);
			this.#emit(worker, text);
		}
	}

	#append(worker: PtyWorker, text: string): void {
		worker.chunks.push(text);
		worker.bytes += text.length;
		while (worker.bytes > RING_BYTES && worker.chunks.length > 1) {
			const dropped = worker.chunks.shift();
			if (dropped) worker.bytes -= dropped.length;
		}
	}

	#emit(worker: PtyWorker, chunk: string): void {
		for (const fn of [...worker.listeners]) {
			try {
				fn(chunk);
			} catch {
				// Listener failures must not kill the pump.
			}
		}
	}
}
