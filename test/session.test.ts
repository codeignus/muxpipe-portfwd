import { spawn } from "node:child_process";

import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "yamux-js";

import { portForwarder } from "../src/index";

describe("Session", () => {
	let yamuxSession: Client;

	beforeEach(async () => {
		const childProc = spawn("go", ["run", "."], {
			cwd: "server",
			stdio: "pipe",
		});
		const forwarder = await portForwarder({
			stdin: childProc.stdin,
			stdout: childProc.stdout,
			stderr: childProc.stderr,
		});
		expect(forwarder).toBeTruthy();

		// biome-ignore lint/suspicious/noExplicitAny: <Accessing private property for testing purposes>
		yamuxSession = (forwarder as any).yamuxSession;
	});

	it("should initialize a yamux session", async () => {
		expect(yamuxSession).toBeTruthy();
	});
});
