// Revision clouds the way drafters draw them: a chain of outward arcs around the change.
export function cloudPath(x0, y0, x1, y1, pad = 10, bump = 9) {
  const X0 = x0 - pad, Y0 = y0 - pad, X1 = x1 + pad, Y1 = y1 + pad;
  const w = X1 - X0, h = Y1 - Y0;
  const per = 2 * (w + h), n = Math.max(8, Math.round(per / (bump * 2)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    let t = (i / n) * per, x, y;
    if (t < w) { x = X0 + t; y = Y0; }
    else if ((t -= w) < h) { x = X1; y = Y0 + t; }
    else if ((t -= h) < w) { x = X1 - t; y = Y1; }
    else { t -= w; x = X0; y = Y1 - t; }
    pts.push([x, y]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i <= n; i++) {
    const [x, y] = pts[i % n], [px, py] = pts[i - 1];
    const r = Math.hypot(x - px, y - py) * 0.62;
    d += ` A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d + 'Z';
}
