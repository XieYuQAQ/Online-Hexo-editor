'use strict';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

class WriteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(ok, status, message) {
  if (!ok) throw new WriteError(status, message);
}

function isSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function safePath(path) {
  return typeof path === 'string' && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function fileKind(path) {
  if (!safePath(path)) return null;
  if (path.startsWith('source/_posts/') && /\.md$/i.test(path)) return 'post';
  const match = path.startsWith('source/images/') && IMAGE_EXT.exec(path);
  return match ? match[1].toLowerCase().replace(/^jpeg$/, 'jpg') : null;
}

function allowedDirectory(path) {
  return safePath(path) && (path === 'source' || /^source\/(?:_posts|images)(?:\/|$)/.test(path));
}

// 只在知道目标路径之后核对图片格式。已有 blob 与刚上传的 blob 走同一条校验。
function imageKind(bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(8) === 13 && ascii(12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) && bytes.readUInt32BE(20)) return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) &&
      bytes.readUInt16LE(6) && bytes.readUInt16LE(8)) return 'gif';
  if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)) && bytes.readUInt32LE(4) === bytes.length - 8) return 'webp';
  if (bytes.length >= 26 && ascii(0, 2) === 'BM' && bytes.readUInt32LE(14) >= 12 &&
      bytes.readUInt32LE(10) < bytes.length) return 'bmp';
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0 &&
      6 + 16 * bytes.readUInt16LE(4) <= bytes.length) return 'ico';
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
    const end = bytes.readUInt32BE(0);
    if (end >= 16 && end <= bytes.length) {
      for (let i = 8; i + 4 <= end; i += 4) {
        if (i !== 12 && ['avif', 'avis'].includes(ascii(i, i + 4))) return 'avif';
      }
    }
  }
  return null;
}

// read() 只能读取代理配置的仓库。此缓存只活在同一个请求中。
function writePolicy(read) {
  const images = new Map();

  async function checkFile(path, entry) {
    const kind = fileKind(path);
    requireValue(kind && entry.type === 'blob' && entry.mode === '100644', 403, '只允许写入 Markdown 文章和普通位图文件');
    if (entry.sha === null) return;
    requireValue(isSha(entry.sha), 400, '无效的 blob SHA');
    if (kind === 'post') return;
    if (!images.has(entry.sha)) {
      const blob = await read('/git/blobs/' + entry.sha);
      requireValue(blob && blob.sha === entry.sha && blob.encoding === 'base64' &&
        typeof blob.content === 'string', 502, '无法核实图片内容');
      images.set(entry.sha, imageKind(Buffer.from(blob.content, 'base64')));
    }
    requireValue(images.get(entry.sha) === kind, 403, '图片文件头与扩展名不匹配');
  }

  async function checkEntries(body) {
    requireValue(isSha(body.base_tree) && Array.isArray(body.tree) && body.tree.length, 400, '需要 base_tree 和文件列表');
    const seen = new Set();
    for (const entry of body.tree) {
      requireValue(entry && !Object.hasOwn(entry, 'content') && !seen.has(entry.path), 400, '条目必须引用唯一的文件路径和 blob SHA');
      seen.add(entry.path);
      await checkFile(entry.path, entry);
    }
    return { base_tree: body.base_tree, tree: body.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })) };
  }

  async function readTree(sha) {
    if (!sha) return new Map();
    const data = await read('/git/trees/' + sha);
    requireValue(data && data.sha === sha && data.truncated === false && Array.isArray(data.tree), 502, '无法取得完整 Git tree');
    const entries = new Map();
    for (const entry of data.tree) {
      requireValue(entry && isSha(entry.sha) && typeof entry.path === 'string' &&
        entry.path && !entry.path.includes('/') && !entries.has(entry.path), 502, 'Git tree 条目不完整');
      entries.set(entry.path, entry);
    }
    return entries;
  }

  // 按目录 SHA 跳过相同子树。新增、删除、改名和模式变化均从两个不可变快照计算。
  async function checkTrees(before, after, dir) {
    if (before === after) return;
    const [oldTree, newTree] = await Promise.all([readTree(before), readTree(after)]);
    const names = new Set([...oldTree.keys(), ...newTree.keys()]);
    requireValue(names.size, 403, '不支持单独增删空目录');
    for (const name of names) {
      const old = oldTree.get(name);
      const next = newTree.get(name);
      if (old && next && old.type === next.type && old.mode === next.mode && old.sha === next.sha) continue;
      const path = dir + name;
      if (old?.type === 'tree' || next?.type === 'tree') {
        requireValue(allowedDirectory(path) && [old, next].every(e => !e || (e.type === 'tree' && e.mode === '040000')),
          403, '提交包含不允许的目录变更');
        await checkTrees(old?.sha, next?.sha, path + '/');
      } else {
        if (old) await checkFile(path, { ...old, sha: null });
        if (next) await checkFile(path, next);
      }
    }
  }

  async function checkRef(branch, sha) {
    requireValue(isSha(sha), 400, '无效的提交 SHA');
    const ref = await read('/git/ref/heads/' + branch);
    const head = ref?.object?.sha;
    requireValue(ref?.object?.type === 'commit' && isSha(head), 502, '无法核实分支当前提交');
    const target = await read('/git/commits/' + sha);
    requireValue(target?.sha === sha && isSha(target.tree?.sha), 502, '无法核实目标提交');
    requireValue(target.parents?.length === 1 && target.parents[0]?.sha === head, 409, '分支已变更或提交不是直接后继，请刷新后重试');
    const parent = await read('/git/commits/' + head);
    requireValue(parent?.sha === head && isSha(parent.tree?.sha), 502, '无法核实父提交');
    await checkTrees(parent.tree.sha, target.tree.sha, '');
  }

  return { checkEntries, checkRef };
}

module.exports = { WriteError, writePolicy };
