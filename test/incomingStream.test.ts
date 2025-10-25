import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Stream } from "yamux-js";

import { portForwarder } from "../src";
import type { PortForwarder } from "../src/portForwarder";

describe("IncomingStream", () => {
	let forwarder: PortForwarder;
	let receivedPorts: number[];

	beforeEach(async () => {
		receivedPorts = [];

		// 1️⃣ Start the port forwarder
		const cmd = "go";
		const args = ["run", "."];
		const cwd = "server";

		forwarder = await portForwarder({ cmd, args, cwd });

		// 2️⃣ Replace onIncomingStream on yamuxSession to only capture ports, not create servers
		// biome-ignore lint/suspicious/noExplicitAny: <Accessing private property for testing purposes>
		const yamuxSession = (forwarder as any).yamuxSession;
		yamuxSession.onIncomingStream = (stream: Stream) => {
			const chunks: Buffer[] = [];

			stream.on("data", (chunk: Buffer) => {
				console.log("Incoming stream data:", chunk.toString("utf-8"));
				chunks.push(chunk);
			});

			stream.on("end", () => {
				try {
					const data = Buffer.concat(chunks).toString("utf-8");
					const message = JSON.parse(data);

					if (message.port && typeof message.port === "number") {
						receivedPorts.push(message.port);
					}
				} catch (_err) {
					// Ignore parsing errors
				}
			});

			stream.on("error", (_err: Error) => {
				// Ignore stream errors
			});
		};
	});

	it("should receive port notifications from server", async () => {
		// Wait for server to detect and send port notifications
		await new Promise((r) => setTimeout(r, 2000));

		// Verify that we received port notifications
		expect(receivedPorts.length).toBeGreaterThan(0);
		expect(receivedPorts.every((port) => typeof port === "number")).toBe(true);
	});

	afterEach(async () => {
		// Cleanup
		await new Promise((r) => setTimeout(r, 500));
	});
});
