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
	private childProc: ChildProcessWithoutNullStreams;

	private constructor(
		options: PortForwarderOptions,
		yamuxSession: Client,
		childProc: ChildProcessWithoutNullStreams,
	) {
		this.logger = options.logger;
		this.servers = new Map();
		this.childProc = childProc;
		this.yamuxSession = yamuxSession;
		this.yamuxSession.onIncomingStream = this.handleIncomingStream;

		this.logger.info("PortForwarder initialized successfully");
	}

	static async _init(
		options: PortForwarderOptions,
		cmd: string,
		args?: string[],
		cwd?: string,
	) {
		options.logger.trace("Setting up child process");
		const childProc = childProcSetup(options.logger, cmd, args, cwd);
		options.logger.trace("Establishing yamux session");
		const yamuxSession = await getYamuxSession(options.logger, childProc);
		return new PortForwarder(options, yamuxSession, childProc);
	}

	private handleIncomingStream = (stream: Stream): void => {
		this.logger.trace(
			`Incoming stream accepted from server (ID: ${stream.ID()})`,
		);

		stream.on("error", (err: Error) => {
			this.logger.error(`[Stream ${stream.ID()}] error: ${err.message}`);
		});

		stream.on("close", () => {
			this.logger.debug(`[Stream ${stream.ID()}] closed`);
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
					this.logger.trace(
						`Port detection notification received: ${message.port}`,
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
		this.logger.debug(`Adding port forward for ${destination}`);
		const message:
			| { type: "tcp"; port: number }
			| { type: "unix"; path: string } =
			"remotePort" in _params
				? { type: "tcp", port: _params.remotePort }
				: { type: "unix", path: _params.remoteUnixPath };

		const connectionHandler = async (socket: net.Socket) => {
			this.logger.trace(`New connection received for ${destination}`);
			// Open a new yamux stream
			const stream = await this.yamuxSession.openStream();
			this.logger.trace(
				`Stream opened (ID: ${stream.ID()}) for ${destination}`,
			);

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
				this.logger.trace(
					`Server acknowledged, piping data for ${destination}`,
				);
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
						this.logger.debug(
							`Port ${port} already in use, trying random port`,
						);
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
					this.logger.info(
						`Port forward established: 127.0.0.1:${serverListeningOnPort} -> ${destination}`,
					);
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

	async removePort(_params: ForwardPortParams): Promise<void> {
		const key: number | string =
			"remotePort" in _params ? _params.remotePort : _params.remoteUnixPath;
		const destination =
			"remotePort" in _params
				? `TCP_PORT: ${_params.remotePort}`
				: `UNIX_PATH: ${_params.remoteUnixPath}`;
		this.logger.debug(`Removing port forward for ${destination}`);
		const server = this.servers.get(key);

		if (!server) {
			this.logger.warn(`No tcpServer found for ${destination}`);
			return;
		}

		return new Promise((resolve, reject) => {
			server.close((err) => {
				if (err) {
					this.logger.error(
						`Error closing tcpServer for ${destination}: ${err.message}`,
					);
					reject(err);
				} else {
					this.logger.info(`tcpServer closed for ${destination}`);
					this.servers.delete(key);
					resolve();
				}
			});
		});
	}

	async destroy(): Promise<void> {
		this.logger.info("Destroying PortForwarder, cleaning up resources");

		// Close all servers
		const closePromises = Array.from(this.servers.entries()).map(
			([key, server]) =>
				new Promise<void>((resolve) => {
					server.close((err) => {
						if (err) {
							this.logger.error(
								`Error closing tcpServer for ${key}: ${err.message}`,
							);
						} else {
							this.logger.debug(`tcpServer closed for ${key}`);
						}
						resolve();
					});
				}),
		);

		await Promise.all(closePromises);
		this.servers.clear();
		this.logger.info("All tcpServers closed");

		// Close yamux session
		try {
			this.yamuxSession.close();
			this.logger.info("Bidirectional pipe's session closed");
		} catch (err) {
			this.logger.error(
				`Error closing Bidirectional pipe's session: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Kill child process
		try {
			this.childProc.kill();
			this.logger.info("Child process killed");
		} catch (err) {
			this.logger.error(
				`Error killing child process: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
