import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { Client, type Stream } from "yamux-js";

import type { Logger } from "./logger";

export function getYamuxSession(
	logger: Logger,
	childProc: ChildProcessWithoutNullStreams,
	handleIncomingStream: (stream: Stream) => void,
) {
	const yamuxSession = new Client();
	childProc.stdout.pipe(yamuxSession).pipe(childProc.stdin);

	yamuxSession.on("error", (err) => {
		logger.error(`Session error: ${err.message}`);
	});

	yamuxSession.onIncomingStream = handleIncomingStream;

	logger.info(`Client Session created with bidirectional support`);

	return yamuxSession;
}

/**
 * asynchronus so that it blocks until server is ready
 */
export async function childProcSetup(
	logger: Logger,
	cmd: string,
	args?: string[],
	cwd?: string,
) {
	const childProc = spawn(cmd, args, { cwd, stdio: "pipe" });

	childProc.on("error", (err) => {
		logger.error(`Command failed: ${err.message}`);
	});
	childProc.on("exit", (code) => {
		logger.info(`Command exited with code: ${code}`);
	});

	childProc.stdin.on("error", (err) => {
		logger.error(`Child process Stdin error: ${err.message}`);
	});

	childProc.stdout.on("error", (err) => {
		logger.error(`Child process Stdout error: ${err.message}`);
	});

	return new Promise<ChildProcessWithoutNullStreams>((resolve) => {
		childProc.stderr.on("data", (data) => {
			const dataStr = data.toString();
			try {
				const jsonLog = JSON.parse(dataStr);
				// Wait for server to be ready
				if (
					jsonLog.source === "server" &&
					jsonLog.message ===
						"Session is created & Server is ready to accept streams"
				) {
					resolve(childProc);
				}

				if (jsonLog.source === "server") {
					logger.error(`${dataStr}`); // Log server logs to stderr, avoid wrapping with pino
				} else {
					logger.info(`${dataStr}`);
				}
			} catch (_) {
				logger.error(`${dataStr}`);
			}
		});
	});
}
