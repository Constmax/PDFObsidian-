import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';

import { ViewerFeature, ViewerLifecycle } from '../src/lib/viewer-lifecycle';
import { Events } from './obsidian-stub';


function setUp(features: ViewerFeature[], { toolbar = {} as object | null } = {}) {
    const events = new Events();
    const plugin = {
        manifest: { name: 'PDF++' },
        on: (name: string, cb: () => unknown) => events.on(name, cb),
        trigger: (name: string) => events.trigger(name),
    };
    const child = { unloaded: false, toolbar };
    const lifecycle = new ViewerLifecycle(plugin as any, child as any, features);
    return { lifecycle, plugin, child, events };
}

const file = { path: 'a.pdf' } as any;

/** A feature that records its calls in `log`. */
function recorder(name: string, log: string[]): ViewerFeature {
    return {
        name,
        viewer: (scope) => {
            log.push(`${name}.viewer`);
            scope.register(() => log.push(`${name}.viewer ended`));
        },
        document: (scope, { file }) => {
            log.push(`${name}.document ${file.path}`);
            scope.register(() => log.push(`${name}.document ended`));
        },
        toolbar: (scope) => {
            log.push(`${name}.toolbar`);
            scope.register(() => log.push(`${name}.toolbar ended`));
        },
    };
}

describe('ViewerLifecycle', () => {
    it('runs the viewer hooks, then the toolbar hooks, in the order of the features', () => {
        const log: string[] = [];
        const { lifecycle } = setUp([recorder('a', log), recorder('b', log)]);

        lifecycle.load();

        expect(log).toEqual(['a.viewer', 'b.viewer', 'a.toolbar', 'b.toolbar']);
    });

    it('replaces the document scope on every load', () => {
        const log: string[] = [];
        const { lifecycle } = setUp([recorder('a', log)]);
        lifecycle.load();
        log.length = 0;

        const first = lifecycle.documentLoaded(lifecycle.beginDocument(), file);
        const second = lifecycle.documentLoaded(lifecycle.beginDocument(), { path: 'b.pdf' } as any);

        expect(log).toEqual(['a.document a.pdf', 'a.document ended', 'a.document b.pdf']);
        expect(first?._loaded).toBe(false);
        expect(second?._loaded).toBe(true);
        expect(lifecycle.document).toBe(second);
        // The previous scope is removed, not just unloaded.
        expect(lifecycle._children).not.toContain(first);
    });

    it('ends the document scope when the next load begins, before it has finished', () => {
        const { lifecycle } = setUp([]);
        lifecycle.load();
        const scope = lifecycle.documentLoaded(lifecycle.beginDocument(), file);

        lifecycle.beginDocument();

        expect(scope?._loaded).toBe(false);
        expect(lifecycle.document).toBeNull();
    });

    it('does not open a scope for a load that was overtaken by a newer one', () => {
        const log: string[] = [];
        const { lifecycle } = setUp([recorder('a', log)]);
        lifecycle.load();
        log.length = 0;

        const older = lifecycle.beginDocument();
        const newer = lifecycle.beginDocument();

        expect(lifecycle.documentLoaded(older, file)).toBeNull();
        expect(log).toEqual([]);
        expect(lifecycle.documentLoaded(newer, file)).not.toBeNull();
        expect(log).toEqual(['a.document a.pdf']);
    });

    it('does not open a scope once the viewer has been unloaded', () => {
        const log: string[] = [];
        const { lifecycle, child } = setUp([recorder('a', log)]);
        lifecycle.load();
        const ticket = lifecycle.beginDocument();

        child.unloaded = true;

        expect(lifecycle.documentLoaded(ticket, file)).toBeNull();
        expect(log).not.toContain('a.document a.pdf');
    });

    it('sets up the toolbar again on update-dom, ending the previous setup first', () => {
        const log: string[] = [];
        const { lifecycle, plugin } = setUp([recorder('a', log)]);
        lifecycle.load();
        log.length = 0;

        plugin.trigger('update-dom');
        plugin.trigger('update-dom');

        expect(log).toEqual(['a.toolbar ended', 'a.toolbar', 'a.toolbar ended', 'a.toolbar']);
        // One toolbar scope, one document scope at most: nothing piles up.
        expect(lifecycle._children).toHaveLength(1);
    });

    it('stops listening to update-dom when the viewer is unloaded', () => {
        const log: string[] = [];
        const { lifecycle, plugin, events } = setUp([recorder('a', log)]);
        lifecycle.load();
        expect(events.count('update-dom')).toBe(1);

        lifecycle.unload();
        log.length = 0;
        plugin.trigger('update-dom');

        expect(events.count('update-dom')).toBe(0);
        expect(log).toEqual([]);
    });

    it('ends the document and toolbar scopes before the viewer scope when unloaded', () => {
        const log: string[] = [];
        const { lifecycle } = setUp([recorder('a', log)]);
        lifecycle.load();
        lifecycle.documentLoaded(lifecycle.beginDocument(), file);
        log.length = 0;

        lifecycle.unload();

        expect(log).toEqual(['a.document ended', 'a.toolbar ended', 'a.viewer ended']);
    });

    it('unloads the components the hooks add along with their scopes', () => {
        const tool = new Component();
        const bibs: Component[] = [];
        const { lifecycle } = setUp([{
            name: 'f',
            viewer: (scope) => { scope.addChild(tool); },
            document: (scope) => { bibs.push(scope.addChild(new Component())); },
        }]);
        lifecycle.load();
        lifecycle.documentLoaded(lifecycle.beginDocument(), file);
        expect(tool._loaded && bibs[0]._loaded).toBe(true);

        // A reload replaces the document's components; the viewer's stay.
        lifecycle.documentLoaded(lifecycle.beginDocument(), file);
        expect(bibs.map((bib) => bib._loaded)).toEqual([false, true]);
        expect(tool._loaded).toBe(true);

        lifecycle.unload();
        expect(tool._loaded).toBe(false);
    });

    it('keeps running the other features when one throws', () => {
        const log: string[] = [];
        const error = vi.spyOn(console, 'error').mockImplementation(() => { });
        const broken: ViewerFeature = {
            name: 'broken',
            viewer: () => { throw new Error('viewer'); },
            document: () => { throw new Error('document'); },
            toolbar: () => { throw new Error('toolbar'); },
        };
        const { lifecycle } = setUp([broken, recorder('a', log)]);

        lifecycle.load();
        lifecycle.documentLoaded(lifecycle.beginDocument(), file);

        expect(log).toEqual(['a.viewer', 'a.toolbar', 'a.document a.pdf']);
        expect(error).toHaveBeenCalledTimes(3);
        error.mockRestore();
    });

    describe('without a toolbar yet', () => {
        beforeEach(() => {
            vi.stubGlobal('window', globalThis);
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        });

        it('sets up the toolbar once it appears within a second', () => {
            const log: string[] = [];
            const { lifecycle, child } = setUp([recorder('a', log)], { toolbar: null });
            lifecycle.load();
            expect(log).toEqual(['a.viewer']);

            vi.advanceTimersByTime(250);
            child.toolbar = {};
            vi.advanceTimersByTime(100);

            expect(log).toEqual(['a.viewer', 'a.toolbar']);
            vi.advanceTimersByTime(2000);
            expect(log).toEqual(['a.viewer', 'a.toolbar']);
        });

        it('gives up after a second', () => {
            const log: string[] = [];
            const { lifecycle, child } = setUp([recorder('a', log)], { toolbar: null });
            lifecycle.load();

            vi.advanceTimersByTime(1100);
            child.toolbar = {};
            vi.advanceTimersByTime(1000);

            expect(log).toEqual(['a.viewer']);
        });
    });
});
