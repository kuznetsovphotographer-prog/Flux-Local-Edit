// Local, dependency-free regression tests for the publication page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const events = {};
  const classes = new Set();
  let captured = null;
  const comparison = {
    events, position: null, width: 400,
    style: { setProperty: (_, value) => { comparison.position = value; } },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    getBoundingClientRect: () => ({ left: 100, width: comparison.width }),
    addEventListener: (name, callback) => { events[name] = callback; },
    setPointerCapture: id => { captured = id; },
    hasPointerCapture: id => captured === id,
    releasePointerCapture: () => { captured = null; },
  };
  const slider = {
    value: '50', text: '', events: {},
    closest: () => ({ querySelector: () => comparison }),
    setAttribute: (_, value) => { slider.text = value; },
    addEventListener: (name, callback) => { slider.events[name] = callback; },
  };
  const pointer = (type, x, overrides = {}) => events[type]({
    type, clientX: x, pointerId: 1, isPrimary: true, button: 0, ...overrides,
  });
  return { comparison, slider, pointer, classes, captured: () => captured };
}

const cases = Array.from({ length: 4 }, fixture);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../docs/assets/site.js'), 'utf8'), {
  document: { querySelectorAll: selector => selector === '[data-slider]' ? cases.map(c => c.slider) : [] },
});
cases.forEach((c, index) => {
  assert.equal(c.comparison.position, '50%');
  c.pointer('pointerdown', 300);
  assert.equal(c.captured(), 1);
  c.pointer('pointermove', 420);
  assert.equal(c.slider.value, '80');
  assert.equal(c.comparison.position, '80%');
  assert.equal(c.slider.text, '80% исходного изображения');
  c.pointer('pointermove', 800);
  assert.equal(c.slider.value, '100');
  c.pointer('pointerup', 0);
  assert.equal(c.slider.value, '0');
  assert.equal(c.captured(), null);
  assert.equal(c.classes.size, 0);
  c.slider.value = '33';
  c.slider.events.input();
  assert.equal(c.comparison.position, '33%');
  c.pointer('pointerdown', 450, { pointerType: 'touch' });
  c.pointer('pointermove', 180, { pointerType: 'touch' });
  assert.equal(c.slider.value, '20');
  c.pointer('pointercancel', 900, { pointerType: 'touch' });
  assert.equal(c.slider.value, '20');
  assert.equal(c.captured(), null);
  c.pointer('pointerdown', 300, { button: 2 });
  c.pointer('pointerdown', 300, { isPrimary: false });
  assert.equal(c.captured(), null);
  c.pointer('pointerdown', 300);
  c.pointer('pointermove', 450, { pointerId: 2 });
  assert.equal(c.slider.value, '50');
  c.pointer('lostpointercapture', 0);
  assert.equal(c.classes.size, 0);
  c.pointer('pointermove', 450);
  assert.equal(c.slider.value, '50');
  c.comparison.width = 0;
  c.pointer('pointerdown', 300);
  assert.equal(c.slider.value, '50');
  c.pointer('pointercancel', 300);
  let prevented = false;
  c.comparison.events.dragstart({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  console.log(`PASS comparison ${index + 1}: mouse/touch, bounds, range sync, cancellation, isolation`);
});
