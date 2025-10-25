import * as net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { portForwarder } from "../src";
import type { PortForwarder } from "../src/portForwarder";

describe("Destroy", () => {
	let forwarder: PortForwarder;
	let remotePort: number;
	let server: net.Server;

	beforeEach(async () => {
		// Create a simple TCP echo server
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

		// Start the port forwarder
		const cmd = "go";
		const args = ["run", "."];
		const cwd = "server";

		forwarder = await portForwarder({ cmd, args, cwd });
	});

	it("should destroy forwarder and clean up resources", async () => {
		// Add a port to forward
		const localPort = await forwarder.addPort({ remotePort });

		// Verify the port is working
		const client = net.createConnection({ port: localPort });
		client.write("test");

		await new Promise((resolve) => {
			client.on("data", (data) => {
				expect(data.toString()).toContain("echo:test");
				client.end();
				resolve(undefined);
			});
		});

		// Wait for client to close
		await new Promise((r) => setTimeout(r, 100));

		// Destroy the forwarder
		await forwarder.destroy();

		// Verify the local port is no longer accessible
		await expect(
			new Promise((resolve, reject) => {
				const testClient = net.createConnection({ port: localPort });
				testClient.on("connect", () => {
					testClient.end();
					reject(new Error("Port should not be accessible after destroy"));
				});
				testClient.on("error", (err) => {
					resolve(err);
				});
			}),
		).resolves.toBeTruthy();
	});

	afterEach(async () => {
		server.close();
	});
});
