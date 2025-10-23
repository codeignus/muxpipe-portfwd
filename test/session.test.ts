import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "yamux-js";

import { portForwarder } from "../src/index";

describe("Session", () => {
	let yamuxSession: Client;

	beforeEach(async () => {
		const cmd = "go";
		const args = ["run", "."];
		const cwd = "server";

		const forwarder = await portForwarder({ cmd, args, cwd });
		expect(forwarder).toBeTruthy();

		// biome-ignore lint/suspicious/noExplicitAny: <Accessing private property for testing purposes>
		yamuxSession = (forwarder as any).yamuxSession;
	});

	it("should initialize a yamux session", async () => {
		expect(yamuxSession).toBeTruthy();
	});
});
