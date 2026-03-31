import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "zero-agent-companion",
		identifier: "com.zero-agent.companion",
		version: "0.1.0",
	},
	build: {
		views: {
			mainview: {
				entrypoint: "src/mainview/index.tsx",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
