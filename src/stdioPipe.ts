import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { Client } from "yamux-js";

import type { Logger } from "./logger";

export async function getYamuxSession(
	logger: Logger,
	childProc: ChildProcessWithoutNullStreams,
) {
	const yamuxSession = new Client();
	childProc.stdout.pipe(yamuxSession).pipe(childProc.stdin);

	yamuxSession.on("error", (err) => {
		logger.error(`Session error: ${err.message}`);
	});

	logger.info(`Client Session created with bidirectional support`);

	// Verify server is ready by pinging
	for (let i = 0; i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		try {
			// biome-ignore lint/suspicious/noExplicitAny: <Accessing private method for session verification>
			await (yamuxSession as any).ping();
			logger.info("Server session verified ready via ping");
			break;
		} catch (_) {
			if (i === 99) {
				throw new Error("Could not verify server session readiness via ping");
			}
		}
	}

	return yamuxSession;
}

/**
 * asynchronus so that it blocks until server is ready
 */
export function childProcSetup(
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

	childProc.stderr.on("data", (data) => {
		const dataStr = data.toString();
		try {
			const jsonLog = JSON.parse(dataStr);
			if (jsonLog.source === "server") {
				logger.error(`${dataStr}`); // Log server logs to stderr, avoid wrapping with pino
			} else {
				logger.info(`${dataStr}`);
			}
		} catch (_) {
			logger.error(`${dataStr}`);
		}
	});

	return childProc;
}
