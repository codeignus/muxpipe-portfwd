import type { Readable, Writable } from "node:stream";

import { Client } from "yamux-js";

import type { Logger } from "./logger";

export type StdioStreams = {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
};

/**
 * asynchronus so that it blocks until server is ready
 */
export async function getYamuxSession(logger: Logger, stdio: StdioStreams) {
	logger.trace("Creating yamux client session");
	// Configure yamux with increased timeouts for stdio-based connections
	// Stdio pipes can experience backpressure, requiring generous timeouts
	const yamuxSession = new Client({
		enableKeepAlive: true,
		keepAliveInterval: 30, // seconds
		connectionWriteTimeout: 60, // 1 minutes in seconds
	});
	stdio.stdout.pipe(yamuxSession).pipe(stdio.stdin);
	logger.trace("Bidirectional pipe established between client and server");

	yamuxSession.on("error", (err) => {
		logger.error(`Session error: ${err.message}`);
	});

	// Verify server is ready by pinging
	logger.trace("Verifying server readiness");
	for (let i = 0; i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		try {
			// biome-ignore lint/suspicious/noExplicitAny: <Accessing private method for session verification>
			await (yamuxSession as any).ping();
			logger.debug(`Server session verified ready after ${(i + 1) * 20}ms`);
			break;
		} catch (_) {
			if (i === 99) {
				logger.error(
					"Server session readiness verification failed after 2000ms",
				);
				throw new Error("Could not verify server session readiness via ping");
			}
		}
	}

	logger.info(`Client Session created with bidirectional support`);
	return yamuxSession;
}

export function stdioSetup(logger: Logger, stdio: StdioStreams) {
	logger.trace("Setting up stdio stream handlers");

	stdio.stdin.on("error", (err) => {
		logger.error(`Stdin error: ${err.message}`);
	});

	stdio.stdout.on("error", (err) => {
		logger.error(`Stdout error: ${err.message}`);
	});

	stdio.stderr.on("error", (err) => {
		logger.error(`Stderr error: ${err.message}`);
	});

	stdio.stderr.on("data", (data) => {
		logger.info(data.toString());
	});

	return stdio;
}
