// scripts/build.mjs — 用 Node 内置类型剥离把 src/index.ts 编成 lib/index.js
// 无需任何依赖：Node >= 22.13 提供 module.stripTypeScriptTypes
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const out = stripTypeScriptTypes(src, { mode: 'strip' })
mkdirSync(new URL('../lib/', import.meta.url), { recursive: true })
writeFileSync(new URL('../lib/index.js', import.meta.url), out)
console.log('built lib/index.js from src/index.ts')
