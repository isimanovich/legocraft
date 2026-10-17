import { installTouchGestureGuard } from './touch-gestures.js';

/** Independent pointer ownership lets two thumbs move/look while another finger acts. */
export class TouchControls {
  constructor({ canvas, root, onMove, onLook, onHold, onAction }) {
    Object.assign(this, { canvas, root, onMove, onLook, onHold, onAction });
    installTouchGestureGuard();
    this.enabled = false;
    this.pointers = new Map();
    this.sprinting = false;
    // Opening a menu on pointerup can retarget the following synthetic click to
    // that menu's backdrop. Consume it so Pause/Bag cannot immediately resume.
    document.addEventListener('pointerdown', () => { this.pendingClick = null; }, true);
    document.addEventListener('click', (event) => {
      const tap = this.pendingClick;
      if (tap && event.detail > 0 && event.timeStamp - tap.time < 700 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 8) {
        this.pendingClick = null;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    this.stick = root.querySelector('#move-stick');
    this.knob = root.querySelector('#move-knob');
    this.sprintButton = root.querySelector('[data-touch-action="sprint"]');
    this.bindPointer(this.stick, 'move');
    this.bindPointer(canvas, 'look');
    for (const button of root.querySelectorAll('[data-touch-hold]')) {
      this.bindPointer(button, button.dataset.touchHold);
    }
    for (const button of root.querySelectorAll('[data-touch-action]')) {
      this.bindPointer(button, `tap:${button.dataset.touchAction}`);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        // Keyboard/assistive activation. Physical pointers are handled separately:
        // browsers do not reliably synthesize clicks for a second touching finger.
        if (this.enabled && event.detail === 0) this.activate(button.dataset.touchAction);
      });
    }
  }

  activate(action) {
    if (action === 'sprint') {
      this.sprinting = !this.sprinting;
      this.sprintButton.setAttribute('aria-pressed', String(this.sprinting));
      this.onHold('sprint', this.sprinting);
    } else this.onAction(action);
  }

  bindPointer(element, role) {
    element.addEventListener('pointerdown', (event) => {
      if (!this.enabled || event.button !== 0 || [...this.pointers.values()].some((p) => p.role === role)) return;
      event.preventDefault();
      const pointer = { role, element, x: event.clientX, y: event.clientY };
      this.pointers.set(event.pointerId, pointer);
      element.setPointerCapture(event.pointerId);
      element.classList.add('pressed');
      if (role === 'move') this.moveStick(event);
      else if (role !== 'look' && !role.startsWith('tap:')) this.onHold(role, true);
    });
    element.addEventListener('pointermove', (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer || pointer.element !== element) return;
      event.preventDefault();
      if (role === 'move') this.moveStick(event);
      else if (role === 'look') this.onLook(event.clientX - pointer.x, event.clientY - pointer.y);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    });
    const release = (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (pointer?.element !== element) return;
      const rect = element.getBoundingClientRect();
      const activate = event.type === 'pointerup' && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      this.release(event.pointerId);
      if (activate && role.startsWith('tap:')) {
        this.pendingClick = { x: event.clientX, y: event.clientY, time: event.timeStamp };
        this.activate(role.slice(4));
      }
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, release);
  }

  moveStick(event) {
    const rect = this.stick.getBoundingClientRect();
    const radius = rect.width * 0.34;
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const length = Math.hypot(dx, dy);
    const magnitude = Math.min(1, length / radius);
    const strength = Math.max(0, (magnitude - 0.12) / 0.88);
    this.knob.style.transform = `translate(${dx / (length || 1) * magnitude * radius}px, ${dy / (length || 1) * magnitude * radius}px)`;
    this.onMove(dx / (length || 1) * strength, -dy / (length || 1) * strength);
  }

  release(id) {
    const pointer = this.pointers.get(id);
    if (!pointer) return;
    this.pointers.delete(id);
    const { element, role } = pointer;
    element.classList.remove('pressed');
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    if (role === 'move') {
      this.knob.style.transform = '';
      this.onMove(0, 0);
    } else if (role !== 'look' && !role.startsWith('tap:')) this.onHold(role, false);
  }

  reset() {
    for (const id of [...this.pointers.keys()]) this.release(id);
    this.sprinting = false;
    this.sprintButton.setAttribute('aria-pressed', 'false');
    this.onHold('sprint', false);
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
    this.root.hidden = !enabled;
  }
}
