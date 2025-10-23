import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as net from "node:net";

import type { Client, Stream } from "yamux-js";

import type { PortForwarderOptions } from "./index.js";
import type { Logger } from "./logger.js";
import { childProcSetup, getYamuxSession } from "./stdioPipe.js";

type ForwardPortParams =
	| { localPort?: number; remotePort: number; remoteUnixPath?: never }
	| { localPort?: number; remoteUnixPath: string; remotePort?: never };

export class PortForwarder {
	private logger: Logger;
	private yamuxSession: Client;
	private servers: Map<number | string, net.Server>;

	private constructor(
		options: PortForwarderOptions,
		childProc: ChildProcessWithoutNullStreams,
	) {
		this.logger = options.logger;
		this.servers = new Map();
		this.yamuxSession = getYamuxSession(
			this.logger,
			childProc,
			this.handleIncomingStream,
		);
	}

	static async _init(
		options: PortForwarderOptions,
		cmd: string,
		args?: string[],
		cwd?: string,
	) {
		const childProc = await childProcSetup(options.logger, cmd, args, cwd);
		return new PortForwarder(options, childProc);
	}

	private handleIncomingStream = (stream: Stream): void => {
		stream.on("error", (err: Error) => {
			this.logger.error(`[Stream ${stream.ID()}] error: ${err.message}`);
		});

		stream.on("close", () => {
			this.logger.info(`[Stream ${stream.ID()}] closed`);
		});

		this.logger.info(
			`Incoming stream accepted from server (ID: ${stream.ID()})`,
		);

		stream.on("data", (data: Buffer) => {
			this.logger.info(`[Stream ${stream.ID()}] Received: ${data.toString()}`);
			// Echo back or handle as needed
			// stream.write(`Client acknowledged: ${data.toString()}`);
		});
	};

	async addPort(_params: ForwardPortParams): Promise<number> {
		let destination: string;
		let message: { type: "tcp"; port: number } | { type: "unix"; path: string };
		if ("remotePort" in _params) {
			destination = `TCP_PORT: ${_params.remotePort}`;
			message = { type: "tcp", port: _params.remotePort };
		} else {
			destination = `UNIX_PATH: ${_params.remoteUnixPath}`;
			message = { type: "unix", path: _params.remoteUnixPath };
		}

		return new Promise((resolve, reject) => {
			const server = net.createServer(async (socket) => {
				this.logger.info(`Opening stream for remote ${destination}`);
				// Open a new yamux stream
				const stream = await this.yamuxSession.openStream();

				// Send the target port or socket path as the first message
				stream.write(JSON.stringify(message));

				// Set up bidirectional forwarding
				socket.pipe(stream).pipe(socket);

				// Handle errors
				stream.on("error", (err) => {
					this.logger.error(
						`Stream error for remote ${destination}: ${err.message}`,
					);
					socket.end();
				});

				socket.on("error", (err) => {
					this.logger.error(
						`Client socket error for remote ${destination}: ${err.message}`,
					);
					stream.end();
				});

				stream.on("close", () => {
					this.logger.info(`Stream closed for remote ${destination}`);
					socket.end();
				});

				socket.on("close", () => {
					this.logger.info(
						`Client socket disconnected for remote ${destination}`,
					);
					stream.end();
				});
			});

			server.on("error", (err) => {
				this.logger.error(
					`net.createServer error for remote ${destination}: ${err.message}`,
				);
				reject(err);
			});

			server.listen(_params.localPort ?? 0, "127.0.0.1", () => {
				const serverListeningOnPort = (server.address() as net.AddressInfo)
					.port;
				this.logger.info(`Listening on 127.0.0.1:${serverListeningOnPort}`);
				this.servers.set(
					"remotePort" in _params ? _params.remotePort : _params.remoteUnixPath,
					server,
				);
				resolve(serverListeningOnPort);
			});
		});
	}
}
