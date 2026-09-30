'use strict';
document.querySelectorAll('[data-slider]').forEach(slider => {
  const comparison = slider.closest('figure, .example')?.querySelector('[data-comparison]');
  if (!comparison) return;
  const update = () => {
    comparison.style.setProperty('--position', `${slider.value}%`);
    slider.setAttribute('aria-valuetext', `${slider.value}% исходного изображения`);
  };
  let activePointer = null;
  const moveTo = clientX => {
    const bounds = comparison.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const percentage = Math.max(0, Math.min(100, (clientX - bounds.left) / bounds.width * 100));
    slider.value = String(Math.round(percentage));
    update();
  };
  comparison.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || activePointer !== null) return;
    activePointer = event.pointerId;
    comparison.setPointerCapture(activePointer);
    comparison.classList.add('is-dragging');
    moveTo(event.clientX);
  });
  comparison.addEventListener('pointermove', event => {
    if (event.pointerId === activePointer) moveTo(event.clientX);
  });
  const endDrag = event => {
    if (event.pointerId !== activePointer) return;
    if (event.type === 'pointerup') moveTo(event.clientX);
    const pointerId = activePointer;
    activePointer = null;
    comparison.classList.remove('is-dragging');
    if (comparison.hasPointerCapture(pointerId)) comparison.releasePointerCapture(pointerId);
  };
  comparison.addEventListener('pointerup', endDrag);
  comparison.addEventListener('pointercancel', endDrag);
  comparison.addEventListener('lostpointercapture', endDrag);
  comparison.addEventListener('dragstart', event => event.preventDefault());
  slider.addEventListener('input', update);
  update();
});
document.querySelectorAll('details').forEach(details => {
  details.addEventListener('toggle', () => {
    if (!details.open) details.querySelectorAll('video').forEach(video => video.pause());
  });
});
document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));
