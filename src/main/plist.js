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
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

// Reads top-level <key>…</key><string>…</string> pairs from an XML plist.
function readXmlStrings(text) {
  const out = {};
  const re = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(text))) {
    const key = decodeXml(m[1]);
    if (!(key in out)) out[key] = decodeXml(m[2]);
  }
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
  if (!offsetSize || !refSize || numObjects > 1e6 || tableOffset >= buf.length) throw new Error('bad bplist trailer');

  const readUInt = (pos, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const offsetOf = (ref) => readUInt(tableOffset + ref * offsetSize, offsetSize);

  const lengthAt = (pos, info) => {
    if (info !== 0xf) return { len: info, start: pos + 1 };
    const marker = buf[pos + 1];
    const size = 1 << (marker & 0xf);
    return { len: readUInt(pos + 2, size), start: pos + 2 + size };
  };

  const parse = (ref, depth) => {
    if (depth > 32 || ref >= numObjects) throw new Error('bad bplist ref');
    const pos = offsetOf(ref);
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
        return buf.subarray(start, start + len);
      }
      case 0x5: {
        const { len, start } = lengthAt(pos, info);
        return buf.toString('latin1', start, start + len);
      }
      case 0x6: {
        const { len, start } = lengthAt(pos, info);
        const chars = Buffer.from(buf.subarray(start, start + len * 2));
        chars.swap16();
        return chars.toString('utf16le');
      }
      case 0xa:
      case 0xc: {
        const { len, start } = lengthAt(pos, info);
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(parse(readUInt(start + i * refSize, refSize), depth + 1));
        return arr;
      }
      case 0xd: {
        const { len, start } = lengthAt(pos, info);
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = parse(readUInt(start + i * refSize, refSize), depth + 1);
          obj[String(key)] = parse(readUInt(start + (len + i) * refSize, refSize), depth + 1);
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
