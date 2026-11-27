// 图片类型判断：必须与博客仓库 source/netlify/functions/lib/github-writes.js 的
// IMAGE_EXT / imageKind() 保持一致，否则会出现「本地放行、服务端 403」。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../assets/core.js');

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

/* ---------------- 构造各格式的最小文件头 ---------------- */

function png() {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(2, 20);
  return b;
}

function jpg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

function gif() {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(2, 6);
  b.writeUInt16LE(2, 8);
  return b;
}

function webp() {
  const b = Buffer.alloc(20);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  return b;
}

function bmp() {
  const b = Buffer.alloc(26);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(24, 10);   // 像素数据偏移，必须小于文件长度
  b.writeUInt32LE(40, 14);   // DIB 头长度
  return b;
}

function ico() {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x00010000, 0);
  b.writeUInt16LE(1, 4);
  return b;
}

function avif() {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write('mif1', 8, 'latin1');
  b.writeUInt32BE(0, 12);
  b.write('avif', 16, 'latin1');
  return b;
}

/* ---------------- 文件头识别 ---------------- */
{
  const cases = [
    ['png', png()], ['jpg', jpg()], ['gif', gif()], ['webp', webp()],
    ['bmp', bmp()], ['ico', ico()], ['avif', avif()],
  ];
  for (const [kind, bytes] of cases) {
    check(Core.imageKind(bytes) === kind, `应识别为 ${kind}`, '实际：' + JSON.stringify(Core.imageKind(bytes)));
  }

  check(Core.imageKind(Buffer.alloc(0)) === '', '空文件不应识别为图片');
  check(Core.imageKind(Buffer.from('%PDF-1.7\n')) === '', 'PDF 不应识别为图片');
  check(Core.imageKind(Buffer.from('<script>alert(1)</script>')) === '', 'HTML 不应识别为图片');
  check(Core.imageKind(Buffer.from('GIF89a')) === '', '截断的 GIF 头应被拒绝');
  check(Core.imageKind(png().subarray(0, 20)) === '', '截断的 PNG 应被拒绝');
}

/* ---------------- 扩展名白名单 ---------------- */
{
  const yes = { 'a.png': 'png', 'a.JPG': 'jpg', 'a.jpeg': 'jpg', 'a.JPEG': 'jpg', 'a.gif': 'gif', 'a.webp': 'webp', 'a.avif': 'avif', 'a.bmp': 'bmp', 'a.ico': 'ico' };
  for (const [name, kind] of Object.entries(yes)) {
    check(Core.imageKindFromName(name) === kind, `${name} 应放行`, '实际：' + Core.imageKindFromName(name));
  }

  for (const name of ['a.svg', 'a.ejs', 'a.js', 'a.html', 'a.txt', 'a', 'a.png.exe']) {
    check(Core.imageKindFromName(name) === '', `${name} 应被拒绝`, '实际：' + Core.imageKindFromName(name));
  }

  check(Core.IMAGE_KINDS.indexOf('svg') === -1, '允许列表里不应包含 svg');
}

/* ---------------- 后缀与内容必须一致 ---------------- */
{
  check(Core.imageKind(png()) !== Core.imageKindFromName('伪装.jpg'), 'PNG 内容 + .jpg 后缀应判定不一致');
  check(Core.imageKind(jpg()) === Core.imageKindFromName('正常.jpg'), 'JPG 内容 + .jpg 后缀应一致');
  check(Core.imageKind(png()) === Core.imageKindFromName('正常.png'), 'PNG 内容 + .png 后缀应一致');
}

console.log(`\n图片类型断言 ${checks} 条，失败 ${failed} 条`);
process.exitCode = failed ? 1 : 0;
