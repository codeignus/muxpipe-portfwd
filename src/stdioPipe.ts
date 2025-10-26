import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { Client } from "yamux-js";

import type { Logger } from "./logger";

/**
 * asynchronus so that it blocks until server is ready
 */
export async function getYamuxSession(
	logger: Logger,
	childProc: ChildProcessWithoutNullStreams,
) {
	logger.trace("Creating yamux client session");
	const yamuxSession = new Client();
	childProc.stdout.pipe(yamuxSession).pipe(childProc.stdin);
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

export function childProcSetup(
	logger: Logger,
	cmd: string,
	args?: string[],
	cwd?: string,
) {
	logger.debug(`Spawning child process: ${cmd}`, { args, cwd });
	const childProc = spawn(cmd, args, { cwd, stdio: "pipe" });
	logger.trace(`Child process spawned with PID: ${childProc.pid}`);

	childProc.on("error", (err) => {
		logger.error(`Command failed: ${err.message}`);
	});
	childProc.on("exit", (code, signal) => {
		if (code === 0) {
			logger.debug(`Command exited successfully`);
		} else if (signal) {
			logger.error(`Command killed by signal: ${signal}`);
		} else {
			logger.error(`Command exited with error code: ${code}`);
		}
	});

	childProc.stdin.on("error", (err) => {
		logger.error(`Command process Stdin error: ${err.message}`);
	});

	childProc.stdout.on("error", (err) => {
		logger.error(`Command process Stdout error: ${err.message}`);
	});

	childProc.stderr.on("error", (err) => {
		logger.error(`Command process Stderr error: ${err.message}`);
	});

	childProc.stderr.on("data", (data) => {
		logger.info(data.toString());
	});

	return childProc;
}
