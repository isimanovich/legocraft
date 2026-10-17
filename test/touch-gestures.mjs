// node --test test/touch-gestures.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTouchGestureGuard } from '../src/touch-gestures.js';

function documentFixture() {
  const doc = new EventTarget();
  const classes = new Set();
  doc.body = { classList: { contains: (name) => classes.has(name) } };
  return { doc, classes };
}

function touchEvent(type, fingers = 1, cancelable = true) {
  const event = new Event(type, { cancelable });
  Object.defineProperty(event, 'touches', { value: Array(fingers).fill({}) });
  return event;
}

test('Touch mode prevents Safari pinch zoom during gameplay and menus', () => {
  const { doc, classes } = documentFixture();
  const remove = installTouchGestureGuard(doc);
  classes.add('touch-mode');
  // The body mode is the only prerequisite: paused/disabled controls must not
  // expose the start, inventory, name or multiplayer menus to accidental zoom.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove']) {
    const event = touchEvent(type, 2);
    doc.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, `${type} prevents browser zoom`);
  }
  remove();
});

test('Single-finger scrolling, native taps, typing and laptop browser zoom remain available', () => {
  const { doc, classes } = documentFixture();
  const remove = installTouchGestureGuard(doc);
  classes.add('touch-mode');
  for (const type of ['touchstart', 'touchmove', 'touchend', 'click', 'focus', 'keydown', 'wheel']) {
    const event = touchEvent(type);
    doc.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${type} keeps its native behavior`);
  }
  classes.delete('touch-mode');
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove']) {
    const event = touchEvent(type, 2);
    doc.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${type} is unchanged in Laptop mode`);
  }
  remove();
});

test('Independent multitouch input still propagates and mode changes apply immediately', () => {
  const { doc, classes } = documentFixture();
  const remove = installTouchGestureGuard(doc);
  let moves = 0;
  doc.addEventListener('touchmove', () => { moves++; });
  for (const touchMode of [false, true, false, true]) {
    if (touchMode) classes.add('touch-mode');
    else classes.delete('touch-mode');
    const event = touchEvent('touchmove', 3);
    doc.dispatchEvent(event);
    assert.equal(event.defaultPrevented, touchMode);
  }
  assert.equal(moves, 4, 'all fingers continue delivering game input');
  // Browsers sometimes deliver noncancelable touchmoves after scroll starts.
  const event = touchEvent('touchmove', 2, false);
  doc.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  remove();
  const unguarded = touchEvent('gesturestart', 2);
  doc.dispatchEvent(unguarded);
  assert.equal(unguarded.defaultPrevented, false, 'cleanup removes gesture listeners');
});
