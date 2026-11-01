/*
 * Compresor bzip2 mínimo para el navegador (FRAN SERVER).
 * Genera archivos .bz2 estándar (los abre bzip2, 7-Zip y el FastDL de Source).
 * BWT por duplicación de prefijos (radix sort), MTF + RLE2, 2 tablas Huffman iguales.
 * Uso: const bz = Bzip2.compress(uint8array)  ->  Uint8Array
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i << 24;
      for (var k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function BitWriter() {
    this.buf = new Uint8Array(1 << 16);
    this.pos = 0;
    this.acc = 0;   // bits pendientes (como máximo 7 + 24)
    this.n = 0;
  }
  BitWriter.prototype.ensure = function (extra) {
    if (this.pos + extra <= this.buf.length) return;
    var size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    var b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  };
  // Escribe hasta 24 bits de una vez
  BitWriter.prototype.bits = function (count, value) {
    this.acc = (this.acc << count) | (value & ((1 << count) - 1));
    this.n += count;
    this.ensure(4);
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  };
  BitWriter.prototype.bits32 = function (value) {
    this.bits(16, (value >>> 16) & 0xffff);
    this.bits(16, value & 0xffff);
  };
  BitWriter.prototype.bits48 = function (hi24, lo24) {
    this.bits(24, hi24);
    this.bits(24, lo24);
  };
  BitWriter.prototype.finish = function () {
    if (this.n > 0) this.bits(8 - this.n, 0);
    return this.buf.slice(0, this.pos);
  };

  // RLE1: 4 bytes iguales + un byte con cuántos más se repiten (0..251)
  function rle1(input, start, end, out) {
    var o = 0, i = start;
    while (i < end) {
      var b = input[i], run = 1;
      while (i + run < end && run < 255 && input[i + run] === b) run++;
      if (run >= 4) {
        out[o++] = b; out[o++] = b; out[o++] = b; out[o++] = b;
        out[o++] = run - 4;
      } else {
        for (var r = 0; r < run; r++) out[o++] = b;
      }
      i += run;
    }
    return o;
  }

  // BWT de rotaciones cíclicas: duplicación de prefijos con radix sort (O(n log n))
  function bwt(s, n) {
    var sa = new Int32Array(n), sa2 = new Int32Array(n);
    var rank = new Int32Array(n), tmp = new Int32Array(n);
    var count = new Int32Array(Math.max(256, n) + 1);
    var i;

    for (i = 0; i < n; i++) count[s[i] + 1]++;
    for (i = 1; i <= 256; i++) count[i] += count[i - 1];
    for (i = 0; i < n; i++) sa[count[s[i]]++] = i;
    var classes = 1;
    rank[sa[0]] = 0;
    for (i = 1; i < n; i++) {
      if (s[sa[i]] !== s[sa[i - 1]]) classes++;
      rank[sa[i]] = classes - 1;
    }

    for (var k = 1; k < n && classes < n; k <<= 1) {
      // Orden por la segunda mitad: desplazar el orden actual k posiciones
      for (i = 0; i < n; i++) {
        var p = sa[i] - k;
        sa2[i] = p < 0 ? p + n : p;
      }
      // Orden estable por la primera mitad
      count.fill(0, 0, classes + 1);
      for (i = 0; i < n; i++) count[rank[i] + 1]++;
      for (i = 1; i <= classes; i++) count[i] += count[i - 1];
      for (i = 0; i < n; i++) {
        var q = sa2[i];
        sa[count[rank[q]]++] = q;
      }
      // Nuevas clases
      tmp[sa[0]] = 0;
      classes = 1;
      for (i = 1; i < n; i++) {
        var a = sa[i], b = sa[i - 1];
        var a2 = a + k; if (a2 >= n) a2 -= n;
        var b2 = b + k; if (b2 >= n) b2 -= n;
        if (rank[a] !== rank[b] || rank[a2] !== rank[b2]) classes++;
        tmp[a] = classes - 1;
      }
      var sw = rank; rank = tmp; tmp = sw;
    }

    var last = new Uint8Array(n), origPtr = 0;
    for (i = 0; i < n; i++) {
      var j = sa[i];
      if (j === 0) origPtr = i;
      last[i] = s[j === 0 ? n - 1 : j - 1];
    }
    return { last: last, origPtr: origPtr };
  }

  // Longitudes Huffman (máx. 17 bits, como bzip2); ningún símbolo queda sin código
  function huffmanLengths(freq, alpha, maxLen) {
    var weight = new Array(alpha), lens = new Uint8Array(alpha);
    for (var i = 0; i < alpha; i++) weight[i] = Math.max(1, freq[i]);
    for (;;) {
      var nodes = [];
      for (i = 0; i < alpha; i++) nodes.push({ w: weight[i], sym: i, l: null, r: null });
      while (nodes.length > 1) {
        nodes.sort(function (x, y) { return x.w - y.w; });
        var x = nodes.shift(), y = nodes.shift();
        nodes.push({ w: x.w + y.w, sym: -1, l: x, r: y });
      }
      var tooLong = false;
      (function walk(node, depth) {
        if (node.sym >= 0) {
          lens[node.sym] = Math.max(1, depth);
          if (depth > maxLen) tooLong = true;
          return;
        }
        walk(node.l, depth + 1);
        walk(node.r, depth + 1);
      })(nodes[0], 0);
      if (!tooLong) return lens;
      for (i = 0; i < alpha; i++) weight[i] = 1 + (weight[i] >> 1);
    }
  }

  function compressBlock(w, block, n, blockCrc) {
    var t = bwt(block, n);

    // Símbolos usados
    var inUse = new Uint8Array(256), i, j;
    for (i = 0; i < n; i++) inUse[block[i]] = 1;
    var unseqToSeq = new Int32Array(256), nInUse = 0;
    for (i = 0; i < 256; i++) if (inUse[i]) unseqToSeq[i] = nInUse++;
    var alpha = nInUse + 2, EOB = nInUse + 1;

    // MTF + RLE2 (RUNA = 0, RUNB = 1)
    var mtf = new Uint16Array(n + 1 + 32), nMtf = 0;
    var order = new Uint8Array(nInUse);
    for (i = 0; i < nInUse; i++) order[i] = i;
    var zPend = 0;
    function flushRun() {
      if (zPend === 0) return;
      zPend--;
      for (;;) {
        mtf[nMtf++] = (zPend & 1) ? 1 : 0;
        if (zPend < 2) break;
        zPend = (zPend - 2) >> 1;
      }
      zPend = 0;
    }
    for (i = 0; i < n; i++) {
      var sym = unseqToSeq[t.last[i]];
      if (order[0] === sym) { zPend++; continue; }
      flushRun();
      j = 1;
      var prev = order[0];
      order[0] = sym;
      while (order[j] !== sym) {
        var cur = order[j];
        order[j] = prev;
        prev = cur;
        j++;
      }
      order[j] = prev;
      mtf[nMtf++] = j + 1;
    }
    flushRun();
    mtf[nMtf++] = EOB;

    // Una tabla Huffman (se escribe dos veces: el formato pide al menos 2)
    var freq = new Int32Array(alpha);
    for (i = 0; i < nMtf; i++) freq[mtf[i]]++;
    var lens = huffmanLengths(freq, alpha, 17);
    var codes = new Int32Array(alpha), code = 0;
    for (var len = 1; len <= 20; len++) {
      for (i = 0; i < alpha; i++) if (lens[i] === len) codes[i] = code++;
      code <<= 1;
    }

    // Cabecera del bloque
    w.bits48(0x314159, 0x265359);
    w.bits32(blockCrc);
    w.bits(1, 0);                 // no aleatorizado
    w.bits(24, t.origPtr);

    var groups = 0;
    for (i = 0; i < 16; i++) {
      for (j = 0; j < 16; j++) if (inUse[i * 16 + j]) { groups |= 1 << (15 - i); break; }
    }
    w.bits(16, groups);
    for (i = 0; i < 16; i++) {
      if (!(groups & (1 << (15 - i)))) continue;
      var bitsUsed = 0;
      for (j = 0; j < 16; j++) if (inUse[i * 16 + j]) bitsUsed |= 1 << (15 - j);
      w.bits(16, bitsUsed);
    }

    var nSelectors = Math.ceil(nMtf / 50);
    w.bits(3, 2);                 // 2 tablas
    w.bits(15, nSelectors);
    for (i = 0; i < nSelectors; i++) w.bits(1, 0);   // todas usan la tabla 0

    for (var g = 0; g < 2; g++) {
      var curr = lens[0];
      w.bits(5, curr);
      for (i = 0; i < alpha; i++) {
        while (curr < lens[i]) { w.bits(2, 2); curr++; }
        while (curr > lens[i]) { w.bits(2, 3); curr--; }
        w.bits(1, 0);
      }
    }

    for (i = 0; i < nMtf; i++) w.bits(lens[mtf[i]], codes[mtf[i]]);
  }

  function compress(input) {
    var w = new BitWriter();
    w.bits(8, 0x42); w.bits(8, 0x5a); w.bits(8, 0x68); w.bits(8, 0x39);   // "BZh9"

    var CHUNK = 700000;           // tras RLE1 nunca pasa de 900 000 (límite de BZh9)
    var block = new Uint8Array(Math.ceil(CHUNK * 1.25) + 8);
    var streamCrc = 0;
    for (var start = 0; start < input.length; start += CHUNK) {
      var end = Math.min(input.length, start + CHUNK);
      var crc = 0xffffffff;
      for (var i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ input[i]) & 0xff]) >>> 0;
      crc = (~crc) >>> 0;
      streamCrc = (((streamCrc << 1) | (streamCrc >>> 31)) ^ crc) >>> 0;
      var n = rle1(input, start, end, block);
      compressBlock(w, block, n, crc);
    }
    w.bits48(0x177245, 0x385090);
    w.bits32(streamCrc);
    return w.finish();
  }

  root.Bzip2 = { compress: compress };
})(typeof window !== 'undefined' ? window : globalThis);
