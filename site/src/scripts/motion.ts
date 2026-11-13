/*
 * Hero motion, ported from T3 Code's marketing site (apps/marketing/src/lib/homeMotion.ts).
 * MIT License. Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changes: TypeScript; the gated list takes any element that reads --home-motion-state; the moving marks are
 * any selector, so /download's sky layers move the same way (Dan, 2026-11-13).
 */
export function startHomeMotion(hero: HTMLElement, field: HTMLElement, extra: HTMLElement[], markSelector = ".hero-float-mark") {
  if (typeof IntersectionObserver === "undefined") return function () {};
  var marks = Array.from(field.querySelectorAll<HTMLElement>(markSelector));
  var gated = marks.concat(extra || []);
  var visible = new Set<Element>();
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var finePointer = window.matchMedia("(pointer: fine)");
  var disposed = false;
  var pointerFrame: number | undefined;
  var pointer: { x: number; y: number } | null = null;

  function canMove(element: HTMLElement) {
    return !disposed && visible.has(element) && document.visibilityState === "visible" && !reducedMotion.matches;
  }
  function canParallax() {
    return finePointer.matches && marks.some(canMove);
  }
  function resetPointer() {
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pointer = null;
    field.style.setProperty("--px", "0px");
    field.style.setProperty("--py", "0px");
  }
  function update() {
    gated.forEach(function (element) {
      element.style.setProperty("--home-motion-state", canMove(element) ? "running" : "paused");
    });
    var parallax = canParallax();
    field.style.setProperty("--parallax-duration", parallax ? "0.7s" : "0s");
    if (!parallax) resetPointer();
  }
  var observer = new IntersectionObserver(function (entries) {
    if (disposed) return;
    entries.forEach(function (entry) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    });
    update();
  });
  gated.forEach(function (element) { observer.observe(element); });

  hero.addEventListener("pointermove", function (event) {
    if (!canParallax()) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (pointerFrame !== undefined) return;
    pointerFrame = requestAnimationFrame(function () {
      pointerFrame = undefined;
      if (!pointer || !canParallax()) return;
      var bounds = hero.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      field.style.setProperty("--px", (((pointer.x - bounds.left) / bounds.width - 0.5) * 36).toFixed(1) + "px");
      field.style.setProperty("--py", (((pointer.y - bounds.top) / bounds.height - 0.5) * 28).toFixed(1) + "px");
    });
  });
  hero.addEventListener("pointerleave", resetPointer);
  document.addEventListener("visibilitychange", update);
  reducedMotion.addEventListener("change", update);
  finePointer.addEventListener("change", update);
  update();
  return function () {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    update();
  };
}
