'use strict';

/**
 * Hex text for ids, routine bytes and PIDs, in the two spellings the tool shows: bare (`0c`, how a PID
 * or a byte appears in a CSV `raw` cell) and with the prefix (`0x0c`, `0x0100`, how a person reads an
 * id). One place, so a width or a case is changed once. The byte-string form of a whole frame
 * (`48 6b d1 ...`) is `hex()` in src/kwp.js.
 */

/** `n` in lower-case hex, left-padded with zeros to `width` digits: hexNum(12) is '0c', hexNum(256, 4) is '0100'. */
const hexNum = (n, width = 2) => n.toString(16).padStart(width, '0');

/** The same with the `0x` prefix: hex0x(12) is '0x0c', hex0x(256, 4) is '0x0100'. */
const hex0x = (n, width = 2) => `0x${hexNum(n, width)}`;

/** A 0x22 data id as shown everywhere: four digits, `0x0041`. */
const idText = (id) => hex0x(id, 4);

module.exports = { hexNum, hex0x, idText };
