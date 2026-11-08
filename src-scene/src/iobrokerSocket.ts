/**
 * Minimal ioBroker socket.io RPC client. Deliberately hand-rolled rather than using
 * @iobroker/socket-client: the web adapter here serves Socket.IO v2.5.0 (a legacy major version,
 * wire-incompatible with the v4 client that `npm install socket.io-client` would pull in today),
 * so this page loads the server's own /socket.io.js (see index.html) - the exact same script
 * vis-2/admin themselves load - which defines the matching global `io()` factory, and this module
 * just wraps the handful of RPC calls (getState, subscribe, getObject) this page needs, in the
 * same emit/callback shape verified against this project's real ioBroker instance during
 * development.
 */

declare const io: (url?: string, opts?: Record<string, unknown>) => IoSocket;

interface IoSocket {
	on(event: string, cb: (...args: unknown[]) => void): void;
	emit(event: string, ...args: unknown[]): void;
}

export interface IobState {
	val: unknown;
	ack: boolean;
	ts: number;
}

export class IobrokerSocket {
	private readonly socket: IoSocket;
	private connectedResolve: (() => void) | undefined;
	public readonly ready: Promise<void>;

	public constructor() {
		this.socket = io();
		this.ready = new Promise(resolve => {
			this.connectedResolve = resolve;
		});
		this.socket.on("connect", () => {
			this.connectedResolve?.();
		});
	}

	public getState(id: string): Promise<IobState | null> {
		return new Promise(resolve => {
			this.socket.emit("getState", id, (_err: unknown, state: IobState | null) => resolve(state ?? null));
		});
	}

	public getObject(id: string): Promise<ioBroker.Object | null> {
		return new Promise(resolve => {
			this.socket.emit("getObject", id, (_err: unknown, obj: ioBroker.Object | null) => resolve(obj ?? null));
		});
	}

	/**
	 * Subscribes to a state id and invokes the callback with every update (not just changes -
	 * matches ioBroker's own subscribeState semantics). Fires once immediately with the current
	 * value, mirroring how the vis-2 widgets in this project already behave.
	 *
	 * @param id - the state id to subscribe to
	 * @param cb - called with the state's current value, then again on every update
	 */
	public subscribeState(id: string, cb: (state: IobState | null) => void): void {
		this.socket.emit("subscribe", id);
		this.socket.on("stateChange", (...args: unknown[]) => {
			const [changedId, state] = args as [string, IobState | null];
			if (changedId === id) {
				cb(state);
			}
		});
		void this.getState(id).then(cb);
	}
}
