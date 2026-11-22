import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(path.join(root, 'native/bin'), { recursive: true })
const compiler = process.env.ZIG_EXE || 'zig'
for (const [source, name, libraries] of [
  ['capture', 'capture-helper', ['d3d11', 'dxgi', 'dwmapi', 'gdi32', 'user32', 'kernel32']],
  ['overlay', 'answer-overlay', ['gdi32', 'user32', 'kernel32']]
]) {
  const result = spawnSync(
    compiler,
    [
      'c++',
      '-target',
      'x86_64-windows-gnu',
      '-std=c++17',
      '-O2',
      '-municode',
      path.join(root, `native/src/${source}.cpp`),
      '-o',
      path.join(root, `native/bin/${name}.exe`),
      ...libraries.map((library) => `-l${library}`)
    ],
    { stdio: 'inherit' }
  )
  if (result.error) {
    console.error('请安装 Zig 0.13，或以 ZIG_EXE 指定编译器路径。')
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status || 1)
}
