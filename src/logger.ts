import pino from "pino";

const timestamp = () => {
	const now = new Date();
	const dateStr =
		now.toISOString().split("T")[0] +
		"T" +
		now.toTimeString().slice(0, 8) +
		now.toLocaleString("en-US", { timeZoneName: "short" }).slice(-3);
	return `,"time":"${dateStr}"`;
};

const logger = pino({
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

export default logger;
