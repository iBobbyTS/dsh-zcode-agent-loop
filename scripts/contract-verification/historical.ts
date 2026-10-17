import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hash } from './oracle.js';
import type { Input } from './classifier.js';
export function readOriginalCapture(): Input {
 const bytes=gunzipSync(readFileSync(new URL('./fixtures/original-289.json.gz',import.meta.url))).toString('utf8');
 if(hash(bytes)!=='2b28b0ee92eb772f30a24c4012b25655df30d5ed1ebb7e88de25fefa5e5d3fac')throw new Error('historical capture fixture changed');
 return JSON.parse(bytes) as Input;
}
