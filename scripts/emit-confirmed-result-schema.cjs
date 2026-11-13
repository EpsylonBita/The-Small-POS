// Native output oracle from the same closed schema the server validates.
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const code = buildSync({ stdin: { contents: `
  import { z } from 'zod';
  import { ConfirmedResultSchema } from '../shared/pos/support/confirmed';
  import { writeFileSync, readFileSync } from 'node:fs';
  const path='src-tauri/src/support/confirmed_result_schema.json';
  const text=JSON.stringify(z.toJSONSchema(ConfirmedResultSchema),null,2)+'\\n';
  if(process.argv.includes('--check')) {if(readFileSync(path,'utf8').replace(/\\r\\n/g,'\\n')!==text)throw new Error('Confirmed result schema drift');}
  else writeFileSync(path,text);
`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'cjs', write: false });
new Function('require', code.outputFiles[0].text)(require);
