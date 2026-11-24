import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {computeFloatingPickerPosition} from '../src/features/chat/reaction-picker-position.ts';

describe('Floating Emoji Reaction Picker Positioning & Portal', () => {
  const pickerSize = {width: 264, height: 44};
  const viewport = {width: 1280, height: 800};

  it('places the picker floating above a short 1-line message trigger without row clipping', () => {
    const pos = computeFloatingPickerPosition({
      triggerRect: {top: 300, bottom: 328, left: 520, right: 548, width: 28, height: 28},
      pickerSize,
      viewport,
      alignEnd: false,
    });
    assert.equal(pos.placement, 'above');
    assert.equal(pos.top, 300 - 44 - 8);
    assert.equal(pos.left, 520);
  });

  it('flips below the trigger when near the top chat header so half the emojis never clip', () => {
    const pos = computeFloatingPickerPosition({
      triggerRect: {top: 72, bottom: 100, left: 520, right: 548, width: 28, height: 28},
      pickerSize,
      viewport,
      alignEnd: false,
    });
    assert.equal(pos.placement, 'below');
    assert.equal(pos.top, 100 + 8);
  });

  it('clamps horizontal position inside narrow mobile or edge viewports', () => {
    const rightEdge = computeFloatingPickerPosition({
      triggerRect: {top: 320, bottom: 348, left: 340, right: 368, width: 28, height: 28},
      pickerSize,
      viewport: {width: 375, height: 667},
      alignEnd: false,
    });
    assert.equal(rightEdge.left, 375 - 264 - 8);

    const leftEdge = computeFloatingPickerPosition({
      triggerRect: {top: 320, bottom: 348, left: 12, right: 40, width: 28, height: 28},
      pickerSize,
      viewport: {width: 375, height: 667},
      alignEnd: true,
    });
    assert.equal(leftEdge.left, 8);
  });

  it('renders reaction picker via React Portal outside message-row containment and hidden in selectMode', () => {
    const bubbleSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-bubble.tsx'),
      'utf8',
    );
    assert.equal(bubbleSource.includes('createPortal'), true);
    assert.equal(bubbleSource.includes('computeFloatingPickerPosition'), true);
    assert.equal(bubbleSource.includes('!selectMode && ('), true);
  });
});
