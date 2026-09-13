/**
 * Airtable の readForPages が返す形を、素の物に戻す。
 *
 * ■ 何だったのか
 *
 * 独自形式ではなく **msgpackr（kriszyp/msgpackr）の records 符号化**。
 * 仕様は msgpackr の pack.js / unpack.js に書いてある。
 *
 *   宣言  d4 72 <id>            fixext1 / ext型 0x72 = "r"   → unpack.js:409
 *         d5 72 <id> <highByte> fixext2（形が64を超える分）    → unpack.js:430
 *                               宣言の直後に「キーの配列」、続けてキーの数だけ値
 *   参照  0x40〜0x7f            素の fixint に見えるが record 参照 → unpack.js:246
 *                               形の番号は token & 0x3f（0〜63）
 *   その他 ext型 0x00 = undefined、ext型 0x62 と 0xc1 = 束ねた文字列
 *
 * ■ 「参照」と「ただの数値」を見分ける必要は無い
 *
 * 送り手が 0x40〜0x7f を数値に使わない。pack.js:364 の数値を書く分岐:
 *
 *     if (value < 0x20 || (value < 0x80 && this.useRecords === false)
 *                      || (value < 0x40 && !this._writeStruct)) {
 *       target[position++] = value;      // 素の fixint
 *     } else { 0xcc <uint8> … }
 *
 * records を使う限り 0x40 以上の数値は必ず 0xcc（uint8）以上で書かれる。
 * よって素の fixint 0x40〜0x7f は例外なく参照。
 *
 * ■ 三度失敗した原因（同じ轍を踏まないため残す）
 *
 *   「0xcc なら数値、素の fixint なら参照」  規則は正しかった。**枠の添字を token & 0x3f に
 *       畳んでいなかった**ため「形91は未宣言」で破綻した。形は64個を何百回も使い回すので、
 *       生のバイトで引くと必ずずれる。
 *   「宣言済みなら参照、未宣言なら数値」    同じ引き違いで食い過ぎた。
 *       なお未宣言番号を数値として返す保険は unpack.js:249 に実在するが、
 *       送り手は通さない（実測4ファイルで発動0回）。常用すると壊れる。
 *   「参照は無い」                        参照は実在する（販売で6,001回）。
 *
 * 「素の fixint の数値が5,535件ある」という以前の観測は、
 * 壊れた読み取りで参照バイトを数値として数えていただけだった。
 *
 * ■ 確かめたこと（2026-09-10）
 *
 * 独立に書いた5つの実装（後戻り／枠の巡回／キー名の型辞書／制約解き／送り手の実装を読む）が
 * 4ファイルすべてで一致した。さらにこの実装は **msgpackr 2.1.0 の Unpackr の結果と
 * バイト単位で一致**することを確かめてある（販売で656,749文字ぶん一致）。
 *
 *   4本すべて流れをちょうど使い切り、最上位はちょうど1個の物
 *   data.name = "TTCF販売" / "TTCF製造" / "TTCF予実" / "TTCF在庫登録"
 *   販売 29表 727項目、得意先 94項目
 *   発注書の 希望納品日最短 = fldibudSBL2qjrQl4 が、miniExtensions のフォーム定義が
 *   表示条件で参照する項目IDと一致（独立した裏付け）
 *
 * ■ バイト列からは決まらない箇所がある
 *
 * キーが0個の形への参照は、参照と読んでも数値と読んでも食う量が同じなので
 * バイト列だけでは決まらない（4ベース計617箇所）。これらは全て
 * sharesById / workflowSectionsById / columnSetById / signedUserContentUrls のような
 * 辞書型のキーの下にあり、数値が入る余地が無いので空の物 {} と読む。
 * どちらに読んでも切れ目と骨格は1バイトも変わらない。
 */
const T = new TextDecoder("utf-8", { fatal: false });

class Reader {
  constructor(buf) {
    this.b = buf;
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.p = 0;
    this.structures = new Map(); // id -> {keys, highByte}
    this.bundle = null;
    this.fallbackCount = 0;      // 未宣言番号を数値として返した回数
    this.refCount = 0;
    this.defCount = 0;
    this.twoByteRefCount = 0;
  }

  u8() { return this.b[this.p++]; }

  str(n) {
    const s = T.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }

  bin(n) {
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }

  arr(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.read();
    return out;
  }

  map(n) {
    const o = {};
    for (let i = 0; i < n; i++) {
      const k = this.read();
      o[typeof k === "string" ? k : String(k)] = this.read();
    }
    return o;
  }

  /** 宣言。キーの配列を読み、そのまま本体（値の並び）を読む */
  define(firstId, highByte) {
    this.defCount++;
    const keys = this.read().map((k) => (k == null ? String(k) : String(k)));
    let id = firstId;
    if (highByte !== undefined) {
      id = firstId < 32 ? -((highByte << 5) + firstId) : (highByte << 5) + firstId;
    }
    const st = { keys, highByte };
    this.structures.set(id, st);
    return this.body(st);
  }

  /** 形の本体。キーの数だけ値を読む */
  body(st) {
    const o = {};
    for (const k of st.keys) o[k] = this.read();
    return o;
  }

  /** 参照 */
  ref(token) {
    const firstId = token & 0x3f;
    const st = this.structures.get(firstId);
    if (!st) {
      // unpack.js:249 の保険。送り手はここを通さない
      this.fallbackCount++;
      return token;
    }
    this.refCount++;
    if (st.highByte === 0) {
      // createSecondByteReader: 参照がもう一バイト食う
      const hb = this.u8();
      if (hb === 0) return this.body(st);
      this.twoByteRefCount++;
      const id = firstId < 32 ? -(firstId + (hb << 5)) : firstId + (hb << 5);
      const st2 = this.structures.get(id);
      if (!st2) throw new Error("Record id is not defined for " + id);
      return this.body(st2);
    }
    return this.body(st);
  }

  ext(len) {
    const type = this.u8();
    if (type === 0x00) {
      // notepack 由来。ext型0 は undefined（unpack.js の currentExtensions[0]）
      this.p += len;
      return undefined;
    }
    if (type === 0x62) {
      // 束ねた文字列（unpack.js:1156）。この4ファイルには出てこないが仕様どおり置く
      if (len !== 4) throw new Error("bundle ext with unexpected length " + len);
      const dataSize = (this.b[this.p] << 24) + (this.b[this.p + 1] << 16) + (this.b[this.p + 2] << 8) + this.b[this.p + 3];
      this.p += 4;
      const dataPosition = this.p;
      this.p += dataSize - 4;
      const prev = this.bundle;
      const b0 = this.read(), b1 = this.read();
      this.bundle = { s: [b0, b1], p0: 0, p1: 0, end: this.p };
      this.p = dataPosition;
      const value = this.read();
      this.p = this.bundle.end;
      this.bundle = prev;
      return value;
    }
    if (type === 0x72) {
      if (len === 1) return this.define(this.u8() & 0x3f);
      if (len === 2) {
        const firstId = this.u8() & 0x3f;
        return this.define(firstId, this.u8());
      }
      throw new Error("record ext with unexpected length " + len);
    }
    return { $ext: type, data: this.bin(len) };
  }

  read() {
    const t = this.u8();
    if (t < 0x80) {
      if (t < 0x40) return t;               // 素の fixint（0〜63）は数値
      return this.ref(t);                   // 0x40〜0x7f は record 参照
    }
    if (t < 0x90) return this.map(t - 0x80);
    if (t < 0xa0) return this.arr(t - 0x90);
    if (t < 0xc0) return this.str(t - 0xa0);
    if (t >= 0xe0) return t - 0x100;        // 負の fixint
    switch (t) {
      case 0xc0: return null;
      case 0xc1: {
        // 束ねた文字列への参照（unpack.js:302）。長さは「文字数」で、符号でどちらの束かを表す
        if (!this.bundle) throw new Error("0xc1 だが束が無い at " + (this.p - 1));
        const n = this.read();
        const bd = this.bundle;
        return n > 0
          ? bd.s[1].slice(bd.p1, (bd.p1 += n))
          : bd.s[0].slice(bd.p0, (bd.p0 -= n));
      }
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.bin(this.u8());
      case 0xc5: { const n = this.v.getUint16(this.p); this.p += 2; return this.bin(n); }
      case 0xc6: { const n = this.v.getUint32(this.p); this.p += 4; return this.bin(n); }
      case 0xc7: { const n = this.u8(); return this.ext(n); }
      case 0xc8: { const n = this.v.getUint16(this.p); this.p += 2; return this.ext(n); }
      case 0xc9: { const n = this.v.getUint32(this.p); this.p += 4; return this.ext(n); }
      case 0xca: { const x = this.v.getFloat32(this.p); this.p += 4; return x; }
      case 0xcb: { const x = this.v.getFloat64(this.p); this.p += 8; return x; }
      case 0xcc: return this.u8();
      case 0xcd: { const x = this.v.getUint16(this.p); this.p += 2; return x; }
      case 0xce: { const x = this.v.getUint32(this.p); this.p += 4; return x; }
      case 0xcf: { const x = this.v.getBigUint64(this.p); this.p += 8; return x <= 9007199254740991n ? Number(x) : x; }
      case 0xd0: { const x = this.v.getInt8(this.p); this.p += 1; return x; }
      case 0xd1: { const x = this.v.getInt16(this.p); this.p += 2; return x; }
      case 0xd2: { const x = this.v.getInt32(this.p); this.p += 4; return x; }
      case 0xd3: { const x = this.v.getBigInt64(this.p); this.p += 8; return (x >= -9007199254740991n && x <= 9007199254740991n) ? Number(x) : x; }
      case 0xd4: return this.ext(1);
      case 0xd5: return this.ext(2);
      case 0xd6: return this.ext(4);
      case 0xd7: return this.ext(8);
      case 0xd8: return this.ext(16);
      case 0xd9: return this.str(this.u8());
      case 0xda: { const n = this.v.getUint16(this.p); this.p += 2; return this.str(n); }
      case 0xdb: { const n = this.v.getUint32(this.p); this.p += 4; return this.str(n); }
      case 0xdc: { const n = this.v.getUint16(this.p); this.p += 2; return this.arr(n); }
      case 0xdd: { const n = this.v.getUint32(this.p); this.p += 4; return this.arr(n); }
      case 0xde: { const n = this.v.getUint16(this.p); this.p += 2; return this.map(n); }
      case 0xdf: { const n = this.v.getUint32(this.p); this.p += 4; return this.map(n); }
      default: throw new Error("unknown token 0x" + t.toString(16) + " at " + (this.p - 1));
    }
  }
}

/** 復号する。流れを使い切らなければ投げる */
export function decodeAir(buf) {
  const r = new Reader(buf);
  const value = r.read();
  if (r.p !== buf.length) {
    throw new Error(`値を読み終えたのにバイトが残っている: ${r.p}/${buf.length}`);
  }
  return {
    /** value と同じもの。既存の呼び出しが .top を見ているので両方出す */
    top: value,
    value,
    stats: {
      bytes: buf.length,
      declarations: r.defCount,
      references: r.refCount,
      twoByteReferences: r.twoByteRefCount,
      fallbackCount: r.fallbackCount,
      structures: r.structures.size,
    },
  };
}


import { readFileSync } from "node:fs";

/** ファイルから読む */
export function decodeAirFile(path) { return decodeAir(readFileSync(path)); }

/**
 * 復号せずに、17文字のIDらしい文字列だけを拾う。
 * 01c-hidden.mjs が画面IDの候補集めに使う（拾ったIDは実際に開いて確かめる）。
 */
export function airIds(buf, prefixes = ["pag", "tbl", "fld", "viw", "wfl", "pel", "wtc", "pbd", "sec", "usr"]) {
  const out = {};
  for (const p of prefixes) out[p] = new Set();
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : Buffer.from(buf).toString("latin1");
  for (const m of s.matchAll(/(pag|tbl|fld|viw|wfl|pel|wtc|pbd|sec|usr)([A-Za-z0-9]{14})/g)) {
    if (!out[m[1]]) continue;
    if (!/\d/.test(m[2])) continue; // pageButtonElement のような英単語を落とす
    out[m[1]].add(m[1] + m[2]);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}
