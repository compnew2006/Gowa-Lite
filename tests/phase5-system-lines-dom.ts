// jsdom global setup for the Phase 5 Path C (system lines) tests.
//
// Imported FIRST by phase5-system-lines.test.ts so a DOM exists before any
// component module is evaluated (ES imports run before the importing
// module's body). Same setup as tests/phase3-claim-copy-dom.ts.
import {JSDOM} from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const {window} = dom;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
// Node 21+ ships a getter-only global `navigator`; define it explicitly.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
});
for (const key of [
  'HTMLElement',
  'Element',
  'Node',
  'DocumentFragment',
  'Text',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLDivElement',
  'HTMLSelectElement',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'PointerEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
] as const) {
  globals[key] = (window as unknown as Record<string, unknown>)[key];
}
// jsdom has no ResizeObserver; a no-op stub keeps renders working in tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globals.ResizeObserver = ResizeObserverStub;
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

export {dom};
