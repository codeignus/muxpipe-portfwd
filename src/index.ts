import { type Logger, pinoLogger } from "./logger.js";
import { PortForwarder as PortForwarderClass } from "./portForwarder.js";
import type { StdioStreams } from "./stdioPipe.js";

export type PortForwarderOptions = {
	logger: Logger;
};

export function portForwarder(
	stdio: StdioStreams,
	options: PortForwarderOptions = { logger: pinoLogger },
) {
	return PortForwarderClass._init(options, stdio);
}

export type PortForwarder = PortForwarderClass;

export type { StdioStreams } from "./stdioPipe.js";
