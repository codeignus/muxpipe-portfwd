import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "yamux-js";

import { portForwarder } from "../src/index";

describe("OutgoingStream", () => {
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

	it("should receive close when closed from remote", async () => {
		const stream = await yamuxSession.openStream();
		return new Promise<void>((resolve, reject) => {
			expect(stream.ID()).toBe(1);

			// stream.resume() or stream.on("data", () => {}) starts flowing data and only then can reach EOF, emit end
			stream.resume();

			stream.on("end", () => {
				expect(stream.readableEnded).toBeTruthy();
				stream.end(); // Triggers close on remote side and emits closed if both sides are closed
			});

			stream.on("finish", () => {
				// Emitted when called stream.end
				expect(stream.writableEnded).toBeTruthy();
			});

			stream.on("close", () => {
				expect(stream.closed).toBeTruthy();
				resolve();
			});

			stream.on("error", (err: Error) => {
				reject(new Error(`Stream error: ${err.message}`));
			});

			const message = { type: "tcp", port: 8080 };
			stream.write(JSON.stringify(message));

			// // Check variable stream.closed before and after 6 seconds
			// setTimeout(() => {
			// 	console.log((stream as any).state);
			// }, 4000);
		});
	});
});
