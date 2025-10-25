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

	private constructor(options: PortForwarderOptions, yamuxSession: Client) {
		this.logger = options.logger;
		this.servers = new Map();
		this.yamuxSession = yamuxSession;
		this.yamuxSession.onIncomingStream = this.handleIncomingStream;
	}

	static async _init(
		options: PortForwarderOptions,
		cmd: string,
		args?: string[],
		cwd?: string,
	) {
		const childProc = childProcSetup(options.logger, cmd, args, cwd);
		const yamuxSession = await getYamuxSession(options.logger, childProc);
		return new PortForwarder(options, yamuxSession);
	}

	private handleIncomingStream = (stream: Stream): void => {
		this.logger.info(
			`Incoming stream accepted from server (ID: ${stream.ID()})`,
		);

		stream.on("error", (err: Error) => {
			this.logger.error(`[Stream ${stream.ID()}] error: ${err.message}`);
		});

		stream.on("close", () => {
			this.logger.info(`[Stream ${stream.ID()}] closed`);
		});

		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		stream.on("end", async () => {
			try {
				const data = Buffer.concat(chunks).toString("utf-8");
				const message = JSON.parse(data);

				if (message.port && typeof message.port === "number") {
					this.logger.info(
						`Port detected notification received: ${message.port}`,
					);
					const localPort = await this.addPort({ remotePort: message.port });
					this.logger.info(
						`Auto-forwarded port ${message.port} to local port ${localPort}`,
					);
				}
			} catch (err) {
				// Not valid JSON or parsing error
				this.logger.error(
					`[Stream ${stream.ID()}] Could not parse message: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});
	};

	async addPort(_params: ForwardPortParams): Promise<number> {
		const destination =
			"remotePort" in _params
				? `TCP_PORT: ${_params.remotePort}`
				: `UNIX_PATH: ${_params.remoteUnixPath}`;
		const message:
			| { type: "tcp"; port: number }
			| { type: "unix"; path: string } =
			"remotePort" in _params
				? { type: "tcp", port: _params.remotePort }
				: { type: "unix", path: _params.remoteUnixPath };

		const connectionHandler = async (socket: net.Socket) => {
			this.logger.info(`Opening stream for remote ${destination}`);
			// Open a new yamux stream
			const stream = await this.yamuxSession.openStream();

			// Handle errors
			stream.on("error", (err) => {
				this.logger.error(
					`Stream error for remote ${destination}: ${err.message}`,
				);
				socket.destroy();
			});

			socket.on("error", (err) => {
				this.logger.error(
					`Client socket error for remote ${destination}: ${err.message}`,
				);
				stream.destroy();
			});

			// Send the target port or socket path as the first message
			stream.write(JSON.stringify(message));

			// Wait for server to acknowledge it's mirror in go: stream.Write([]byte("OK")) to avoid racing between pipe and first message
			// Now it only sets pipe after server sends acknowledgement and data is buffered not lost until then
			stream.once("data", () => {
				// Now pipe, set up bidirectional forwarding
				socket.pipe(stream).pipe(socket);
			});

			// when client connected calls end on client, pipe calls end on stream -> when stream ends pipe calls end on socket
			// So socket got end from client(remote) and pipe(local) so socket is completely closed
			// pipe(local) calls stream end so finish is triggered on stream while waiting for end to be triggered by remote server,
			// and on both finish and end will stream be completely closed
		};

		const tryListen = (port: number): Promise<number> => {
			return new Promise((resolve, reject) => {
				const server = net.createServer(connectionHandler);

				server.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE" && !_params.localPort && port !== 0) {
						this.logger.info(`Port ${port} already in use, trying random port`);
						resolve(tryListen(0));
					} else {
						this.logger.error(
							`Create tcpServer error for remote ${destination}: ${err.message}`,
						);
						reject(err);
					}
				});

				server.listen(port, "127.0.0.1", () => {
					const serverListeningOnPort = (server.address() as net.AddressInfo)
						.port;
					this.logger.info(`Listening on 127.0.0.1:${serverListeningOnPort}`);
					this.servers.set(
						"remotePort" in _params
							? _params.remotePort
							: _params.remoteUnixPath,
						server,
					);
					resolve(serverListeningOnPort);
				});
			});
		};

		const portToTry =
			_params.localPort ?? ("remotePort" in _params ? _params.remotePort : 0);
		return tryListen(portToTry);
	}
}
