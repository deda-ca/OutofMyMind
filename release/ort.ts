// onnxruntime-node's native binding, in the release binary. The package loads
// it from a path computed at run time, and the binding needs libonnxruntime.so
// beside it ($ORIGIN), so build.ts points the package here instead: both files
// are unpacked into one folder and the binding is loaded from there.

import path from 'node:path'
import { ORT } from './.generated/embedded.ts'
import { unpack } from './unpack.ts'

const dir = unpack('onnxruntime', ORT)
const module = { exports: {} as unknown }
process.dlopen(module, path.join(dir, 'onnxruntime_binding.node'))

export const binding = module.exports
