/**
 * Error handling for fire-and-forget work (timer callbacks, state-change handlers): a failure is
 * logged as a warning and reported to Sentry instead of surfacing as an unhandled promise rejection,
 * which would crash and restart the adapter.
 */

/** The part of the adapter instance this module needs (keeps it testable without ioBroker). */
export interface SafeAsyncAdapter {
	/** Adapter logger. */
	log: { debug(msg: string): void; warn(msg: string): void };
	/** Whether js-controller supports plugins (Sentry). */
	supportsFeature?(feature: "PLUGINS"): boolean;
	/** Returns a plugin instance (Sentry), or null when it is not configured/enabled. */
	getPluginInstance?(name: string): Record<string, any> | null;
}

/** Errors thrown by state/object calls while the adapter is shutting down - expected, not a bug. */
const SHUTDOWN_ERROR = /\bDB closed\b|Connection is closed/i;

/** Per adapter instance: context|message pairs already sent to Sentry. */
const reported = new WeakMap<SafeAsyncAdapter, Set<string>>();

/**
 * Logs a failed background task and reports it to Sentry (each distinct context/message once per
 * adapter run, so a failing timer does not flood Sentry). Shutdown errors only go to the debug log.
 *
 * @param adapter - the adapter instance
 * @param context - short description of the task, e.g. "Cost sampling"
 * @param error - the thrown value
 */
export function handleTaskError(adapter: SafeAsyncAdapter, context: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (SHUTDOWN_ERROR.test(message)) {
		adapter.log.debug(`${context} skipped: ${message}`);
		return;
	}
	adapter.log.warn(`${context} failed: ${message}`);

	let seen = reported.get(adapter);
	if (!seen) {
		seen = new Set();
		reported.set(adapter, seen);
	}
	const key = `${context}|${message}`;
	if (seen.has(key)) {
		return;
	}
	seen.add(key);
	try {
		if (adapter.supportsFeature?.("PLUGINS")) {
			const sentry = adapter.getPluginInstance?.("sentry")?.getSentryObject?.();
			sentry?.captureException?.(error);
		}
	} catch {
		// reporting must never break the adapter
	}
}

/**
 * Runs an async task without awaiting it; a rejection (or synchronous throw) goes to
 * {@link handleTaskError}.
 *
 * @param adapter - the adapter instance
 * @param context - short description of the task, e.g. "History refresh"
 * @param task - the work to run
 */
export function runSafely(adapter: SafeAsyncAdapter, context: string, task: () => Promise<unknown>): void {
	let promise: Promise<unknown>;
	try {
		promise = task();
	} catch (error) {
		handleTaskError(adapter, context, error);
		return;
	}
	promise.catch((error: unknown) => handleTaskError(adapter, context, error));
}
