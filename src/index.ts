import { PortForwarder as PortForwarderClass } from "./portForwarder.js";

export function portForwarder(cmd: string, args?: string[], cwd?: string) {
	return PortForwarderClass._init(cmd, args, cwd);
}

export type PortForwarder = PortForwarderClass;
