/** biome-ignore-all lint/suspicious/noExplicitAny: <Logger args are of type any[] for most logger libraries> */
import pino from "pino";

export interface Logger {
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(error: string | Error, ...args: any[]): void;
	debug?(message: string, ...args: any[]): void;
	trace?(message: string, ...args: any[]): void;
}

const timestamp = () => {
	const now = new Date();
	const dateStr =
		now.toISOString().split("T")[0] +
		"T" +
		now.toTimeString().slice(0, 8) +
		now.toLocaleString("en-US", { timeZoneName: "short" }).slice(-3);
	return `,"time":"${dateStr}"`;
};

export const pinoLogger = pino({
	level: process.env.PINO_LOG_LEVEL || "info",
	base: { source: "client" },
	timestamp,
	formatters: {
		level(label) {
			return { level: label };
		},
	},
	transport: {
		target: "pino/file",
		options: {
			colorize: false,
			destination: 2,
		},
	},
});
