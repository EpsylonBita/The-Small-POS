// Visual fixtures use production components, Tailwind and translations, with
// the IPC/PIN boundary replaced. Never starts a till or sends a correction.
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const out = path.join(root, 'test-results/order-sync-notices');
await fs.mkdir(out, {recursive:true});
const stub = {
  OrderSyncNoticeStore: `export const useOrderNotices=()=>globalThis.noticeFixture; export const readOrderNoticeStatus=()=>globalThis.noticeFixture.status; export const refreshOrderNotices=async()=>{}; export const openOrderNotice=()=>{};`,
  usePrivilegedActionConfirmation: `export const usePrivilegedActionConfirmation=()=>({confirmationModal:null,runWithPrivilegedConfirmation:async()=>{}});`,
  SupportRemedyRunner: `export const acquireRecoveryAction=()=>()=>{};export const buildRecoveryActionRequest=()=>({});export const executeHealthRecoveryAction=async()=>({}); export const orderRecoveryFeedback=()=> 'callSupport'; export const recoveryFailureCode=()=> 'UNCLASSIFIED_REFUSAL';`,
  lib: `export const getBridge=()=>({invoke:async()=>null});`,
  OrderNoticeRemedy: `export const readOrderNoticeRemedy=async()=>null;`,
  SyncRecoveryModal: `export const SyncRecoveryModal=()=>null;`,
  'server-reachability': `export const isTillKnownOffline=()=>false;export const subscribeServerReachability=()=>()=>{};`,
};
await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import i18next from 'i18next';import {initReactI18next} from 'react-i18next';import {OrderSyncNotice,OrderSyncMark,ShiftOrderSyncNotices} from './src/renderer/components/recovery/OrderSyncNotice';import en from './src/locales/en.json';import el from './src/locales/el.json';
export async function render(lng,state){await i18next.use(initReactI18next).init({lng,resources:{en:{translation:en},el:{translation:el}},interpolation:{escapeValue:false}});const row={orderId:'order',orderNumber:'125',queueId:'queue',since:'today',kind:'customer_correction_refused',state:state==='pending'||state==='automatic'?'pending':'refused',automatic:state==='automatic',actions:['resendOrderCustomerCorrection','keepServerOrderCustomerDetails']};globalThis.noticeFixture={notices:state==='loading'||state==='empty'?[]:[row,...(state==='several'?[{...row,queueId:'payment',kind:'payment_not_on_server',actions:[]}]:[])],status:state==='loading'?'loading':state==='stale'?'stale':'fresh'};return renderToStaticMarkup(<main><div className="rounded-2xl border border-zinc-300 p-4 dark:border-zinc-700"><strong>125</strong><div><OrderSyncMark orderId="order"/></div></div><article className="my-5 rounded-2xl border border-zinc-300 p-5 dark:border-zinc-700"><OrderSyncNotice orderId="order"/></article><ShiftOrderSyncNotices/></main>);}`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(out,'fixture.mjs'),plugins:[{name:'fixture-boundaries',setup(build){build.onResolve({filter:/lib$|OrderNoticeRemedy$|OrderSyncNoticeStore$|usePrivilegedActionConfirmation$|SupportRemedyRunner$|SyncRecoveryModal$|server-reachability$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stub[args.path],loader:'js'}));}}]});
const css = await postcss([tailwind()]).process(await fs.readFile('src/index.css','utf8'),{from:path.join(root,'src/index.css')});
const {render} = await import(pathToFileURL(path.join(out,'fixture.mjs')));
for(const lang of ['en','el']) for(const theme of ['light','dark']) for(const state of ['refused','pending','automatic','stale','several','loading','empty']) {
 const body=await render(lang,state);
 await fs.writeFile(path.join(out,`${lang}-${theme}-${state}.html`),`<!doctype html><html class="${theme==='dark'?'dark':''}" lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\nbody{margin:0;padding:20px;font-family:Arial,sans-serif;background:${theme==='dark'?'#18181b':'#fffaf1'};color:${theme==='dark'?'#fafafa':'#18181b'};--pos-s-text:${theme==='dark'?'#fafafa':'#18181b'};--pos-s-muted:${theme==='dark'?'#d4d4d8':'#52525b'}}main{max-width:800px;margin:auto}</style>${body}</html>`,'utf8');
}
console.log(out);
