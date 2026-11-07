import test from 'node:test';
import assert from 'node:assert/strict';
import { DomButton, DomComponent, DomImage } from '../src/ui/dom/components.ts';
import { DomAssets } from '../src/ui/dom/assets.ts';
import { ActionPressGate } from '../src/ui/action-press-gate.ts';
import { DomActionControls } from '../src/ui/dom/action-controls.ts';
import { CONTROL_PARTS, type ControlSkin } from '../src/domain/control-skin.ts';

class Element extends EventTarget {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  hidden = false; removed = false; src = '';
  children: Element[] = [];
  captures = new Set<number>();
  attributes = new Map<string, string>();
  classList = { add: (..._names: string[]) => {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: Element) { this.children.push(child); return child; }
  remove() { this.removed = true; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
}
function harness() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element(), createElementNS: () => new Element() } });
  const restore = () => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); };
  return { parent: new Element() as unknown as HTMLElement, restore };
}
function pointer(target: HTMLElement, name: string, id: number, x = 20) {
  const event = new Event(name, { cancelable: true });
  Object.assign(event, { pointerId: id, button: 0, clientX: x, clientY: 20 });
  target.dispatchEvent(event);
}

test('pointer capture, shared action exclusion and cancellation recover correctly', () => {
  const h = harness();
  try {
    const gate = new ActionPressGate(); let actions = 0;
    const options = { enabled: () => true, trigger: 'down' as const, action: () => { actions++; }, press: (id: number) => gate.press(id), release: (id: number) => gate.release(id) };
    const a = new DomButton(h.parent, options), b = new DomButton(h.parent, options);
    pointer(a.element, 'pointerdown', 8); pointer(b.element, 'pointerdown', 9);
    assert.equal(actions, 1);
    pointer(a.element, 'pointercancel', 99);
    pointer(b.element, 'pointerdown', 9);
    assert.equal(actions, 1);
    pointer(a.element, 'pointercancel', 8);
    pointer(b.element, 'pointerdown', 9); assert.equal(actions, 2);
    b.visible(false);
    pointer(a.element, 'pointerdown', 10); assert.equal(actions, 3);
    a.destroy(); b.destroy();
  } finally { h.restore(); }
});

test('release activation requires the same pointer inside the button', () => {
  const h = harness();
  try {
    let actions = 0;
    const button = new DomButton(h.parent, { enabled: () => true, trigger: 'up', action: () => { actions++; } });
    pointer(button.element, 'pointerdown', 1); pointer(button.element, 'pointerup', 2);
    assert.equal(actions, 0);
    pointer(button.element, 'pointerup', 1, 120); assert.equal(actions, 0);
    pointer(button.element, 'pointerdown', 3); pointer(button.element, 'pointerup', 3);
    assert.equal(actions, 1); button.element.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(actions, 1); button.destroy();
  } finally { h.restore(); }
});

test('destroying a parent cancels and removes its descendants', () => {
  const h = harness();
  try {
    const parent = new DomComponent(h.parent), child = new DomComponent(parent);
    parent.destroy(); parent.destroy();
    assert.equal(child.signal.aborted, true);
    assert.equal((child.element as unknown as Element).removed, true);
  } finally { h.restore(); }
});

test('cover cropping retains source pixels and releases its asset on destruction', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 200, height: 100 }), atlas: async () => ({ frames: {} }) });
    const image = new DomImage(h.parent).rect({ x: 0, y: 0, width: 50, height: 50 }).fitting('cover');
    await image.load(assets, 'portrait.png');
    const picture = (image.element as unknown as Element).children[0];
    assert.equal(picture.style.width, '100px'); assert.equal(picture.style.left, '-25px');
    image.destroy(); assert.equal(assets.size, 0);
  } finally { h.restore(); }
});

test('DOM wheel dispatches skills and items, respects cooldowns and cancels held actions when hidden', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 94, height: 94 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const calls: string[] = [], errors: unknown[] = [];
    const wheel = new DomActionControls(h.parent, skin, { attack: () => calls.push('attack'), skill: id => calls.push(id), item: id => calls.push(id), swap: () => calls.push('swap') }, error => errors.push(error), assets);
    wheel.setShortcutPage([
      { entry: { kind: 'skill', id: 'skill' }, icon: 'skill.png', quantity: 0, enabled: true },
      { entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 2, enabled: true }
    ]);
    wheel.visible(true);
    const buttons = (wheel.element as unknown as Element).children;
    pointer(buttons[1] as unknown as HTMLElement, 'pointerdown', 1);
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 2);
    assert.deepEqual(calls, ['skill']);
    wheel.visible(false); wheel.visible(true);
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 2);
    assert.deepEqual(calls, ['skill', 'potion']);
    pointer(buttons[2] as unknown as HTMLElement, 'pointerup', 2);
    wheel.setCooldowns({ skill: { durationMs: 1000, remainingMs: 500 } });
    pointer(buttons[1] as unknown as HTMLElement, 'pointerdown', 3);
    assert.equal(calls.length, 2);
    assert.equal(wheel.snapshot()[0].cooldown?.remainingMs, 500);
    wheel.setCooldowns({});
    pointer(buttons[1] as unknown as HTMLElement, 'pointerdown', 4);
    assert.equal(calls.length, 3);
    wheel.setCooldowns({ skill: { durationMs: 1000, remainingMs: 900 } });
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 5);
    assert.equal(calls.length, 3, '技能进入冷却后，按住它的手指仍拥有动作互斥');
    wheel.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});
