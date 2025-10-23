import { type Logger, pinoLogger } from "./logger.js";
import { PortForwarder as PortForwarderClass } from "./portForwarder.js";

export type PortForwarderOptions = {
	logger: Logger;
};

export function portForwarder(
	{ cmd, args, cwd }: { cmd: string; args?: string[]; cwd?: string },
	options: PortForwarderOptions = { logger: pinoLogger },
) {
	return PortForwarderClass._init(options, cmd, args, cwd);
}

export type PortForwarder = PortForwarderClass;
