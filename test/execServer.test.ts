import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { Readable, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { portForwarder } from "../src";
import type { PortForwarder } from "../src/portForwarder";

// VSCode ExecServer types
type Thenable<T> = Promise<T>;

interface ProcessExit {
	readonly status: number;
	readonly message?: string;
}

type Event<T> = (listener: (e: T) => void) => { dispose(): void };

interface ReadStream {
	readonly onDidReceiveMessage: Event<Uint8Array>;
	readonly onEnd: Thenable<void>;
}

interface WriteStream {
	write(data: Uint8Array): void;
	end(): void;
}

interface SpawnedCommand {
	readonly stdin: WriteStream;
	readonly stdout: ReadStream;
	readonly stderr: ReadStream;
	readonly onExit: Thenable<ProcessExit>;
}

interface ExecServerSpawnOptions {
	cwd?: string;
}

interface ExecServer {
	spawn(
		command: string,
		args: string[],
		options?: ExecServerSpawnOptions,
	): Promise<SpawnedCommand>;
}

// Minimal adapters to convert VSCode streams to Node.js streams
function toReadable(readStream: ReadStream): Readable {
	const readable = new Readable({ read() {} });

	readStream.onDidReceiveMessage((data) => readable.push(Buffer.from(data)));
	readStream.onEnd.then(() => readable.push(null));

	return readable;
}

function toWritable(writeStream: WriteStream): Writable {
	return new Writable({
		write(chunk, _, callback) {
			try {
				writeStream.write(new Uint8Array(chunk));
				callback();
			} catch (err) {
				callback(err as Error);
			}
		},
		final(callback) {
			try {
				writeStream.end();
				callback();
			} catch (err) {
				callback(err as Error);
			}
		},
	});
}

// Mock VSCode streams wrapping Node.js child_process streams
class MockVSCodeReadStream implements ReadStream {
	private emitter = new EventEmitter();
	private endPromise: Promise<void>;

	constructor(nodeStream: NodeJS.ReadableStream) {
		this.endPromise = new Promise((resolve) => {
			nodeStream.on("data", (chunk) => {
				const data = Buffer.isBuffer(chunk)
					? new Uint8Array(chunk)
					: new Uint8Array(Buffer.from(chunk));
				this.emitter.emit("message", data);
			});

			nodeStream.on("end", () => {
				resolve();
			});
		});
	}

	get onDidReceiveMessage(): Event<Uint8Array> {
		return (listener) => {
			this.emitter.on("message", listener);
			return { dispose: () => this.emitter.off("message", listener) };
		};
	}

	get onEnd(): Thenable<void> {
		return this.endPromise;
	}
}

class MockVSCodeWriteStream implements WriteStream {
	constructor(private nodeStream: NodeJS.WritableStream) {}

	write(data: Uint8Array): void {
		this.nodeStream.write(Buffer.from(data));
	}

	end(): void {
		this.nodeStream.end();
	}
}

// Mock implementation of ExecServer for testing
class MockExecServer implements ExecServer {
	async spawn(
		command: string,
		args: string[],
		options?: ExecServerSpawnOptions,
	): Promise<SpawnedCommand> {
		const childProc = spawn(command, args, {
			cwd: options?.cwd,
			stdio: "pipe",
		});

		return {
			stdin: new MockVSCodeWriteStream(childProc.stdin),
			stdout: new MockVSCodeReadStream(childProc.stdout),
			stderr: new MockVSCodeReadStream(childProc.stderr),
			onExit: new Promise((resolve) => {
				childProc.on("exit", (code) => {
					resolve({ status: code ?? -1 });
				});
			}),
		};
	}
}

describe("ExecServerIntegration", () => {
	let forwarder: PortForwarder;
	let remotePort: number;
	let server: net.Server;

	beforeEach(async () => {
		server = net.createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
		await new Promise<void>((r) => {
			server.listen(0, () => {
				remotePort = (server.address() as net.AddressInfo).port;
				r();
			});
		});

		const cmd = await new MockExecServer().spawn("go", ["run", "."], {
			cwd: "server",
		});
		forwarder = await portForwarder({
			stdin: toWritable(cmd.stdin),
			stdout: toReadable(cmd.stdout),
			stderr: toReadable(cmd.stderr),
		});
	});

	it("should work with ExecServer", async () => {
		const localPort = await forwarder.addPort({ remotePort });
		const client = net.createConnection({ port: localPort });
		let data = "";
		client.on("data", (d) => {
			data += d;
		});
		client.write("test");
		await new Promise((r) => setTimeout(r, 500));
		client.end();
		expect(data).toContain("echo:test");
		await new Promise((r) => setTimeout(r, 100));
	});

	afterEach(() => server.close());
});
