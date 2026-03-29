/**
 * DXF 2000 (AC1015) Writer - Unicode (Japanese) support via MTEXT
 */

function w(code, val) {
  return `${code}\r\n${val}\r\n`;
}

function ff(n) {
  return Number(n).toFixed(6);
}

/** Handle counter for unique DXF handles (hex) */
let _handleCounter = 0;
function nextHandle() {
  _handleCounter++;
  return _handleCounter.toString(16).toUpperCase();
}

function resetHandles() {
  _handleCounter = 0;
}

/**
 * Encode a Unicode string for DXF MTEXT.
 * Non-ASCII characters are encoded as \\U+XXXX sequences.
 */
function encodeDxfUnicode(text) {
  let result = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7E) {
      result += ch;
    } else if (code > 0x7E) {
      result += '\\U+' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    // Control chars below 0x20 are dropped (except handled by \\P for newline)
  }
  return result;
}

export class DxfWriter {
  constructor() {
    this.layers = new Map();
    this.entities = [];
    this.extMin = [Infinity, Infinity];
    this.extMax = [-Infinity, -Infinity];
  }

  _upd(x, y) {
    if (x < this.extMin[0]) this.extMin[0] = x;
    if (y < this.extMin[1]) this.extMin[1] = y;
    if (x > this.extMax[0]) this.extMax[0] = x;
    if (y > this.extMax[1]) this.extMax[1] = y;
  }

  addLayer(name, color) {
    if (!this.layers.has(name)) {
      this.layers.set(name, { color });
    }
    return this;
  }

  addLwPolyline(layer, points, closed = false) {
    if (!points || points.length < 2) return this;
    for (const [x, y] of points) this._upd(x, y);
    this.entities.push({ type: 'PL', layer, points, closed });
    return this;
  }

  addPoint(layer, x, y) {
    this._upd(x, y);
    this.entities.push({ type: 'PT', layer, x, y });
    return this;
  }

  addLine(layer, x1, y1, x2, y2) {
    this._upd(x1, y1);
    this._upd(x2, y2);
    this.entities.push({ type: 'LN', layer, x1, y1, x2, y2 });
    return this;
  }

  addMText(layer, x, y, height, text) {
    this._upd(x, y);
    const encoded = encodeDxfUnicode(text);
    this.entities.push({ type: 'MT', layer, x, y, height, text: encoded });
    return this;
  }

  toString() {
    resetHandles();
    let s = '';

    // === HEADER ===
    s += w(0, 'SECTION');
    s += w(2, 'HEADER');
    s += w(9, '$ACADVER');  s += w(1, 'AC1015');
    s += w(9, '$DWGCODEPAGE'); s += w(3, 'ANSI_932');
    s += w(9, '$MEASUREMENT'); s += w(70, '1');
    s += w(9, '$PDMODE');   s += w(70, '3');
    s += w(9, '$PDSIZE');   s += w(40, '2.0');
    s += w(9, '$LTSCALE');  s += w(40, '100.0');
    if (this.extMin[0] !== Infinity) {
      s += w(9, '$EXTMIN');
      s += w(10, ff(this.extMin[0])); s += w(20, ff(this.extMin[1])); s += w(30, '0.0');
      s += w(9, '$EXTMAX');
      s += w(10, ff(this.extMax[0])); s += w(20, ff(this.extMax[1])); s += w(30, '0.0');
      s += w(9, '$LIMMIN');
      s += w(10, ff(this.extMin[0])); s += w(20, ff(this.extMin[1]));
      s += w(9, '$LIMMAX');
      s += w(10, ff(this.extMax[0])); s += w(20, ff(this.extMax[1]));

      // View settings to prevent ClippedView warning
      const cx = (this.extMin[0] + this.extMax[0]) / 2;
      const cy = (this.extMin[1] + this.extMax[1]) / 2;
      const dx = this.extMax[0] - this.extMin[0];
      const dy = this.extMax[1] - this.extMin[1];
      const viewSize = Math.max(dx, dy) * 1.1; // 10% margin

      s += w(9, '$VIEWCTR');
      s += w(10, ff(cx)); s += w(20, ff(cy));
      s += w(9, '$VIEWSIZE');
      s += w(40, ff(viewSize));
      s += w(9, '$VIEWDIR');
      s += w(10, '0.0'); s += w(20, '0.0'); s += w(30, '1.0');
    }
    s += w(0, 'ENDSEC');

    // === TABLES ===
    s += w(0, 'SECTION');
    s += w(2, 'TABLES');

    // LTYPE
    s += w(0, 'TABLE');
    s += w(2, 'LTYPE');
    s += w(5, nextHandle());
    s += w(70, '1');
    s += w(0, 'LTYPE');
    s += w(5, nextHandle());
    s += w(2, 'CONTINUOUS');
    s += w(70, '0');
    s += w(3, 'Solid line');
    s += w(72, '65');
    s += w(73, '0');
    s += w(40, '0.0');
    s += w(0, 'ENDTAB');

    // STYLE table (needed for MTEXT with Unicode)
    s += w(0, 'TABLE');
    s += w(2, 'STYLE');
    s += w(5, nextHandle());
    s += w(70, '1');
    s += w(0, 'STYLE');
    s += w(5, nextHandle());
    s += w(2, 'Standard');
    s += w(70, '0');
    s += w(40, '0.0');
    s += w(41, '1.0');
    s += w(50, '0.0');
    s += w(71, '0');
    s += w(42, '2.5');
    s += w(3, 'txt');
    s += w(4, '');
    s += w(0, 'ENDTAB');

    // LAYER
    s += w(0, 'TABLE');
    s += w(2, 'LAYER');
    s += w(5, nextHandle());
    s += w(70, String(this.layers.size + 1));
    s += w(0, 'LAYER');
    s += w(5, nextHandle());
    s += w(2, '0');
    s += w(70, '0');
    s += w(62, '7');
    s += w(6, 'CONTINUOUS');
    for (const [name, { color }] of this.layers) {
      s += w(0, 'LAYER');
      s += w(5, nextHandle());
      s += w(2, name);
      s += w(70, '0');
      s += w(62, String(color));
      s += w(6, 'CONTINUOUS');
    }
    s += w(0, 'ENDTAB');

    s += w(0, 'ENDSEC');

    // === BLOCKS (empty) ===
    s += w(0, 'SECTION');
    s += w(2, 'BLOCKS');
    s += w(0, 'ENDSEC');

    // === ENTITIES ===
    s += w(0, 'SECTION');
    s += w(2, 'ENTITIES');
    for (const e of this.entities) {
      switch (e.type) {
        case 'PL': {
          s += w(0, 'POLYLINE');
          s += w(5, nextHandle());
          s += w(8, e.layer);
          s += w(66, '1');
          s += w(70, e.closed ? '1' : '0');
          for (const [x, y] of e.points) {
            s += w(0, 'VERTEX');
            s += w(5, nextHandle());
            s += w(8, e.layer);
            s += w(10, ff(x));
            s += w(20, ff(y));
          }
          s += w(0, 'SEQEND');
          s += w(5, nextHandle());
          s += w(8, e.layer);
          break;
        }
        case 'PT': {
          s += w(0, 'POINT');
          s += w(5, nextHandle());
          s += w(8, e.layer);
          s += w(10, ff(e.x));
          s += w(20, ff(e.y));
          s += w(30, '0.0');
          break;
        }
        case 'LN': {
          s += w(0, 'LINE');
          s += w(5, nextHandle());
          s += w(8, e.layer);
          s += w(10, ff(e.x1));
          s += w(20, ff(e.y1));
          s += w(30, '0.0');
          s += w(11, ff(e.x2));
          s += w(21, ff(e.y2));
          s += w(31, '0.0');
          break;
        }
        case 'MT': {
          s += w(0, 'MTEXT');
          s += w(5, nextHandle());
          s += w(8, e.layer);
          s += w(10, ff(e.x));
          s += w(20, ff(e.y));
          s += w(30, '0.0');
          s += w(40, ff(e.height));
          s += w(71, '1');       // Attachment point: top-left
          s += w(72, '1');       // Drawing direction: left-to-right
          s += w(1, e.text);
          s += w(7, 'Standard');
          break;
        }
      }
    }
    s += w(0, 'ENDSEC');

    // === EOF ===
    s += w(0, 'EOF');
    return s;
  }
}
