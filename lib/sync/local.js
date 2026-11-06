// Detect a local Baidu Netdisk sync folder.
//
// The official open-platform OAuth needs an AppKey the user has to register,
// which almost nobody has. The desktop client, however, mounts a real folder
// ("同步空间") that it uploads in the background — writing there is enough to
// get papers, translations and notes into the cloud, and to read them back on
// the next machine.

import { access, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CANDIDATES = () => {
  const home = homedir()
  const list = [
    { path: join(home, 'BaiduNetdiskWorkspace'), flavour: '同步空间' },
    { path: join(home, 'Documents', 'BaiduNetdiskWorkspace'), flavour: '同步空间' },
    { path: join(home, 'BaiduNetdiskDownload'), flavour: '下载目录' },
    { path: join(home, 'Documents', 'BaiduNetdiskDownload'), flavour: '下载目录' },
    { path: join(home, 'Downloads', 'BaiduNetdiskDownload'), flavour: '下载目录' },
  ]
  // Any drive root that holds a sync space (common when it was moved to D:).
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    list.push({ path: drive + '\\BaiduNetdiskWorkspace', flavour: '同步空间' })
  }
  return list
}

/** Ask the registry where the client keeps its folders (Windows only). */
function registryPaths() {
  if (process.platform !== 'win32') return Promise.resolve([])
  const keys = [
    ['HKCU\\Software\\Baidu\\BaiduNetdisk', 'DownloadPath'],
    ['HKCU\\Software\\Baidu\\BaiduNetdisk', 'SyncPath'],
    ['HKCU\\Software\\Baidu\\BaiduYun', 'DownloadPath'],
  ]
  return Promise.all(keys.map(([key, value]) => new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const match = stdout.match(/REG_SZ\s+(.+)/)
      resolve(match ? match[1].trim() : null)
    })
  }))).then((list) => list.filter(Boolean))
}

export async function detectBaiduLocal() {
  const found = []
  const seen = new Set()
  for (const extra of await registryPaths()) {
    CANDIDATES().push({ path: extra, flavour: /sync|同步/i.test(extra) ? '同步空间' : '下载目录' })
  }
  for (const candidate of CANDIDATES()) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    const info = await stat(candidate.path).catch(() => null)
    if (!info?.isDirectory()) continue
    const writable = await access(candidate.path, constants.W_OK).then(() => true).catch(() => false)
    found.push({ path: candidate.path, flavour: candidate.flavour, writable })
  }
  // Prefer the real sync space over the download folder.
  found.sort((a, b) => (a.flavour === b.flavour ? 0 : a.flavour === '同步空间' ? -1 : 1))
  return found
}

export function targetPathFor(dir) {
  return join(dir, 'DeepPaperReading')
}
