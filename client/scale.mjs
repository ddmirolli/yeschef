// One style pass (hill climb 2, r1): every radius on the 6/10/16/22 scale and every text one of five sizes
// (12, 14, 16, 20, 24), applied to the whole sheet, the base sheet (pass.css) included, so no rule drifts off it.
// Hairline radii (2 px and under), pills (999px, 50%) and the 9 px letter in a project mark stay as they are.
export const RADIUS = (n) => (n <= 2 ? n : n <= 7 ? 6 : n <= 12 ? 10 : n <= 18 ? 16 : n <= 27 ? 22 : n);
export const SIZE = (n) => (n < 10 ? n : n <= 12.5 ? 12 : n <= 15 ? 14 : n <= 17 ? 16 : n <= 22 ? 20 : 24);
export const onScale = (css) => css
  .replace(/border-radius:([^;}]+)/g, (all, v) => 'border-radius:' + v.replace(/([0-9.]+)px/g, (m, n) => RADIUS(+n) + 'px'))
  .replace(/(font-size:|font:(?:[0-9]{3} |italic )*)([0-9.]+)px/g, (all, pre, n) => pre + SIZE(+n) + 'px');
