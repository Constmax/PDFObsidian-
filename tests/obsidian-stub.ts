/**
 * The parts of Obsidian's runtime API the tested modules use. The `obsidian` package only has
 * type definitions, so tests import this instead (see vitest.config.mjs).
 *
 * `Component` follows Obsidian's implementation (app.js, Obsidian 1.13): `load()` runs `onload()`
 * before loading the children; `unload()` unloads the children last-added first, then runs the
 * registered callbacks in reverse, then `onunload()`.
 */

export class Component {
    _loaded = false;
    _children: Component[] = [];
    _events: (() => void)[] = [];

    load() {
        if (this._loaded) return;
        this._loaded = true;
        this.onload();
        for (const child of this._children.slice()) child.load();
    }

    unload() {
        if (!this._loaded) return;
        this._loaded = false;
        while (this._children.length) this._children.pop()!.unload();
        while (this._events.length) this._events.pop()!();
        this.onunload();
    }

    onload() { }

    onunload() { }

    addChild<T extends Component>(child: T): T {
        this._children.push(child);
        if (this._loaded) child.load();
        return child;
    }

    removeChild<T extends Component>(child: T): T {
        const index = this._children.indexOf(child);
        if (index !== -1) {
            this._children.splice(index, 1);
            child.unload();
        }
        return child;
    }

    register(cb: () => void) {
        this._events.push(cb);
    }

    registerEvent(ref: EventRef) {
        this.register(() => ref.e.offref(ref));
    }

    registerDomEvent(el: EventTarget, type: string, cb: (evt: any) => any, options?: boolean | AddEventListenerOptions) {
        el.addEventListener(type, cb, options);
        this.register(() => el.removeEventListener(type, cb, options));
    }

    registerInterval(id: number) {
        this.register(() => clearInterval(id));
        return id;
    }
}

export interface EventRef {
    e: Events;
    name: string;
    fn: (...data: unknown[]) => unknown;
}

export class Events {
    private handlers = new Map<string, EventRef[]>();

    on(name: string, fn: (...data: unknown[]) => unknown): EventRef {
        const ref = { e: this, name, fn };
        this.handlers.set(name, [...this.handlers.get(name) ?? [], ref]);
        return ref;
    }

    offref(ref: EventRef) {
        this.handlers.set(ref.name, (this.handlers.get(ref.name) ?? []).filter((r) => r !== ref));
    }

    trigger(name: string, ...data: unknown[]) {
        for (const ref of this.handlers.get(name) ?? []) ref.fn(...data);
    }

    count(name: string) {
        return this.handlers.get(name)?.length ?? 0;
    }
}
