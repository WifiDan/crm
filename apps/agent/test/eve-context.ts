/**
 * Runs a function inside an eve async context, so code that uses
 * `defineState` (focus, sources) behaves in a test exactly as it does in a
 * tool call. Eve keeps its context store on a well-known global symbol; this
 * supplies a container with the same shape its own `ContextContainer` has.
 */

type Key = { name: string };

/**
 * Anything `defineState` puts in a slot. Eve's own container is type-erased
 * here too — this file is exempted from the anti-slop boundary rules in
 * `.oxlintrc.json` for exactly that reason.
 */
type StateValue = unknown;

type Container = {
	get(key: Key): StateValue | undefined;
	has(key: Key): boolean;
	require(key: Key): StateValue;
	set(key: Key, value: StateValue): StateValue;
	ensure(key: Key, initial: () => StateValue): StateValue;
	clearVirtualContext(): void;
	setVirtualContext(key: Key, value: StateValue): void;
};

type Storage = {
	run<T>(store: Container, fn: () => T): T;
};

const STORAGE = Symbol.for("eve.context-storage");

function container(): Container {
	const values = new Map<string, StateValue>();

	const self: Container = {
		get: (key) => values.get(key.name),
		has: (key) => values.has(key.name),
		require: (key) => {
			const held = values.get(key.name);
			if (held === undefined) {
				throw new Error(`Context key "${key.name}" is not set.`);
			}
			return held;
		},
		set: (key, value) => {
			values.set(key.name, value);
			return value;
		},
		ensure: (key, initial) =>
			self.has(key) ? self.require(key) : self.set(key, initial()),
		clearVirtualContext: () => {},
		setVirtualContext: (key, value) => {
			values.set(key.name, value);
		},
	};

	return self;
}

export async function inEveContext<T>(fn: () => Promise<T>): Promise<T> {
	// Importing eve/context is what installs the async-local store.
	await import("eve/context");

	const storage = (globalThis as unknown as Record<symbol, Storage>)[STORAGE];

	if (!storage) {
		throw new Error("eve did not install its context storage.");
	}

	return storage.run(container(), fn);
}

/** A minimal research-purpose session context for tools that take one. */
export const researchCtx = {
	session: {
		id: "test-session",
		auth: { current: { attributes: {} }, initiator: null },
	},
} as never;
