import * as net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { portForwarder } from "../src";
import type { PortForwarder } from "../src/portForwarder";

describe("ForwardPort", () => {
	let forwarder: PortForwarder;
	let remotePort: number;
	let server: net.Server;

	beforeEach(async () => {
		// 1️⃣ Create a simple TCP echo server
		server = net.createServer((socket) => {
			socket.on("data", (data) => {
				socket.write(`echo:${data}`);
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, () => {
				remotePort = (server.address() as net.AddressInfo).port;
				resolve();
			});
		});

		// 2️⃣ Start the port forwarder
		const cmd = "go";
		const args = ["run", "."];
		const cwd = "server";

		forwarder = await portForwarder({ cmd, args, cwd });
	});

	it("should forward tcp port and avoid racing issues", async () => {
		const localPort = await forwarder.addPort({ remotePort });

		const client = net.createConnection({ port: localPort });

		const received: string[] = [];
		client.on("data", (data) => {
			received.push(data.toString());
		});

		// 3️⃣ Send messages periodically
		const sendMessages = ["one", "two", "three", "four", "five"];
		for (const msg of sendMessages) {
			client.write(msg);
			await new Promise((r) => setTimeout(r, 100)); // small delay between messages
		}

		// Wait for all responses to arrive
		await new Promise((r) => setTimeout(r, 500));

		client.end();

		expect(received).toContain("echo:one");
		expect(received).toContain("echo:five");
		expect(received.length).toBe(sendMessages.length);
		await new Promise((r) => setTimeout(r, 1000));
	});

	it("should end stream", { timeout: 10000 }, async () => {
		const localPort = await forwarder.addPort({ remotePort });

		const client = net.createConnection({ port: localPort });

		client.on("data", (data) => {
			expect(data.toString()).toEqual("echo:Hello");
		});

		client.write("Hello");

		// Wait for while before closing
		await new Promise((r) => setTimeout(r, 5000));

		client.end();

		await new Promise((r) => setTimeout(r, 2000));
	});

	afterEach(async () => {
		server.close();
	});
});
