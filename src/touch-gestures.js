/**
 * Safari can still recognize page gestures while different fingers own game
 * controls. Cancel only native zoom gestures; pointer events continue to reach
 * the movement, camera and action controls independently.
 */
export function installTouchGestureGuard(doc = document) {
  const preventZoom = (event) => {
    if (!doc.body.classList.contains('touch-mode') || !event.cancelable) return;
    // A single finger must retain native menu scrolling, input focus and clicks.
    if (event.type === 'touchmove' && event.touches.length < 2) return;
    event.preventDefault();
  };
  // The standard touch-action rules handle double-tap zoom. These listeners
  // cover Safari's proprietary pinch events and its multitouch fallback, even
  // when gameplay is paused or a room/name form is open.
  const types = ['gesturestart', 'gesturechange', 'gestureend', 'touchmove'];
  const options = { capture: true, passive: false };
  for (const type of types) doc.addEventListener(type, preventZoom, options);
  return () => {
    for (const type of types) doc.removeEventListener(type, preventZoom, options);
  };
}
