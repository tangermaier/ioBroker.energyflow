// ioBroker eslint template configuration file for js and ts files
// @ts-ignore: no declaration file for module '@iobroker/eslint-config'
import config from "@iobroker/eslint-config";

export default [
	...config,

	{
		// specify files to exclude from linting here
		ignores: [
			"*.test.js",
			"test/**/*.js",
			"**/*.test.ts",
			"*.config.mjs",
			"build",
			"admin/build",
			"admin/words.js",
			"admin/admin.d.ts",
			"**/adapter-config.d.ts",
			".dev-server/**",
			// bundled build output
			"widgets/**",
			"www/**",
			"src-widgets/build/**",
			"src-scene/build/**",
			"**/vite.config.ts",
		],
	},
];
