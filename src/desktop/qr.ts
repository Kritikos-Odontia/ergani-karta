// SPDX-License-Identifier: EUPL-1.2
import qrcode from 'qrcode-generator';

/**
 * A QR code of `text` as one SVG element — drawn on the owner's page so a phone's camera opens the one-time enrolment
 * link (30 minutes, once). One path of dark squares on a white ground, a 4-module quiet zone, error correction M; no
 * script, no style attribute, nothing fetched — it passes the page's CSP as it is.
 * ⓘ Byte mode, UTF-8: the link is ASCII (http://<private address>:<port>/enroll/<token>).
 */
export function qrSvg(text: string, size = 240): string {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const side = count + quiet * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${side}" height="${side}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  );
}
