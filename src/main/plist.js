'use strict';

/*
 * Minimal property-list reader (XML and binary "bplist00") so cleanMac can read
 * app names from Info.plist files without spawning a process per app.
 */

const fs = require('fs');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

// Reads top-level <key>…</key><string>…</string> pairs from an XML plist.
function readXmlStrings(text) {
  const out = {};
  const tokens = text.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<[^>]*>|[^<]+/g) || [];
  const stack = [];
  let root = null;
  let pendingKey = null;
  const finish = (node) => {
    if (stack[stack.length - 1] !== root || !root) return;
    if (node.tag === 'key') pendingKey = node.text;
    else {
      if (node.tag === 'string' && pendingKey != null && !Object.prototype.hasOwnProperty.call(out, pendingKey)) {
        Object.defineProperty(out, pendingKey, { value: node.text, enumerable: true, writable: true, configurable: true });
      }
      pendingKey = null;
    }
  };
  for (const token of tokens) {
    if (/^<!--|^<\?|^<!DOCTYPE/.test(token)) continue;
    const parent = stack[stack.length - 1];
    if (token.startsWith('<![CDATA[')) {
      if (parent) parent.text += token.slice(9, -3);
    } else if (token[0] !== '<') {
      if (parent) parent.text += decodeXml(token);
    } else if (token.startsWith('</')) {
      const tag = token.match(/^<\/([\w:-]+)\s*>$/)?.[1];
      const node = stack.pop();
      if (!node || node.tag !== tag) throw new Error('Malformed XML plist');
      finish(node);
    } else {
      const tag = token.match(/^<([\w:-]+)(?:\s[^>]*)?\/?\s*>$/)?.[1];
      if (!tag) throw new Error('Malformed XML plist');
      const node = { tag, text: '' };
      if (!root && tag === 'dict' && (!parent || parent.tag === 'plist')) root = node;
      if (parent === root && tag !== 'string' && tag !== 'key') pendingKey = null;
      if (/\/\s*>$/.test(token)) finish(node);
      else stack.push(node);
    }
  }
  if (stack.length) throw new Error('Malformed XML plist');
  return out;
}

function readBinary(buf) {
  if (buf.length < 40) throw new Error('bplist too short');
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
  const topObject = Number(buf.readBigUInt64BE(trailer + 16));
  const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize) ||
      !Number.isSafeInteger(numObjects) || numObjects < 1 || numObjects > 1e6 ||
      !Number.isSafeInteger(topObject) || topObject >= numObjects ||
      !Number.isSafeInteger(tableOffset) || tableOffset < 8 || tableOffset + numObjects * offsetSize > trailer) {
    throw new Error('bad bplist trailer');
  }

  const readUInt = (pos, size) => {
    if (!Number.isSafeInteger(pos) || pos < 0 || size < 1 || size > 8 || pos + size > buf.length) throw new Error('bad bplist integer');
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    if (!Number.isSafeInteger(v)) throw new Error('bplist integer is too large');
    return v;
  };
  const offsetOf = (ref) => readUInt(tableOffset + ref * offsetSize, offsetSize);

  const lengthAt = (pos, info) => {
    if (info !== 0xf) return { len: info, start: pos + 1 };
    const marker = buf[pos + 1];
    if ((marker >> 4) !== 0x1 || (marker & 0xf) > 3) throw new Error('bad bplist length');
    const size = 1 << (marker & 0xf);
    return { len: readUInt(pos + 2, size), start: pos + 2 + size };
  };

  const checkRange = (start, size) => {
    if (!Number.isSafeInteger(size) || size < 0 || start + size > tableOffset) throw new Error('bad bplist length');
  };

  let remainingObjects = 1e6;
  const parse = (ref, depth) => {
    if (--remainingObjects < 0 || depth > 32 || ref >= numObjects) throw new Error('bad bplist ref');
    const pos = offsetOf(ref);
    if (pos < 8 || pos >= tableOffset) throw new Error('bad bplist offset');
    const marker = buf[pos];
    const type = marker >> 4;
    const info = marker & 0xf;
    switch (type) {
      case 0x0:
        return info === 0x9 ? true : info === 0x8 ? false : null;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) return Number(buf.readBigInt64BE(pos + 1));
        return readUInt(pos + 1, size);
      }
      case 0x2:
        return info === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
      case 0x3:
        return new Date((buf.readDoubleBE(pos + 1) + 978307200) * 1000);
      case 0x4: {
        const { len, start } = lengthAt(pos, info);
        checkRange(start, len);
        return buf.subarray(start, start + len);
      }
      case 0x5: {
        const { len, start } = lengthAt(pos, info);
        checkRange(start, len);
        return buf.toString('latin1', start, start + len);
      }
      case 0x6: {
        const { len, start } = lengthAt(pos, info);
        checkRange(start, len * 2);
        const chars = Buffer.from(buf.subarray(start, start + len * 2));
        chars.swap16();
        return chars.toString('utf16le');
      }
      case 0xa:
      case 0xc: {
        const { len, start } = lengthAt(pos, info);
        checkRange(start, len * refSize);
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(parse(readUInt(start + i * refSize, refSize), depth + 1));
        return arr;
      }
      case 0xd: {
        const { len, start } = lengthAt(pos, info);
        checkRange(start, len * refSize * 2);
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = parse(readUInt(start + i * refSize, refSize), depth + 1);
          Object.defineProperty(obj, String(key), { value: parse(readUInt(start + (len + i) * refSize, refSize), depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return obj;
      }
      default:
        return null;
    }
  };

  return parse(topObject, 0);
}

/** Returns the top-level string values of a plist file, or null. */
function readPlistStrings(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  try {
    if (buf.subarray(0, 8).toString('latin1') === 'bplist00') {
      const obj = readBinary(buf);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    return readXmlStrings(buf.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { readPlistStrings, readBinary, readXmlStrings };
