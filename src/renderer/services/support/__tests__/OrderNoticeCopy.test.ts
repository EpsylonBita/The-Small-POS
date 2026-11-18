// @vitest-environment node
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { localeBundles } from '../../../../locales/bundles';
import { buildSyncRecoveryIssues, customerCorrectionIssue, orderRecoveryIssues } from '../../../components/recovery/sync-recovery-issues';
import { matchHealthRemedies } from '../SupportMatcherBridge';
const notice={orderId:'order',orderNumber:'12',queueId:'q',since:'today',kind:'customer_correction_refused' as const,state:'refused' as const,actions:['resendOrderCustomerCorrection','keepServerOrderCustomerDetails']};
const staffKeys = ['checkUnavailableGuidance', 'checkUnavailableHealth', 'checkUnavailable', 'checkUnavailableMany', 'needsAction', 'customer_correction_refused', 'change_refused', 'payment_not_on_server', 'next', 'resend', 'guided', 'pending', 'failedAgain', 'failed', 'changed', 'offline', 'wait', 'busy', 'loading', 'stale', 'shift', 'shiftHint', 'order', 'toast', 'moveBlocked', 'movesBlocked', 'remainsActive', 'saving', 'tryAgain', 'notSolved', 'noRemedy'];
// Stems cover inflected forms too; normalize accents before checking.
const bannedWords = {
 en: /database|server|synch?|conflict|recover|queue|version|refus|correction|restor/i,
 el: /βαση δεδομεν|διακομισ|συγχρον|συγκρου|ανακτη|αποκαταστ|ουρα|εκδοσ|απορρι|διορθωσ/i,
 de: /datenbank|server|synchron|konflikt|wiederherstell|warteschlang|version|abgelehn|korrektur/i,
 fr: /base de donnees|serveur|synchron|conflit|recuper|restaur|file d.attente|version|refus|correction/i,
 it: /database|server|sincron|conflitt|recuper|ripristin|coda|version|rifiut|correzion/i,
 sq: /baza e te dhenave|server|sinkron|konflikt|rikuper|rimekemb|radhe|version|refuz|korrigj/i,
};
describe('order recovery copy and catalogue',()=>{
 it.each(Object.keys(localeBundles) as (keyof typeof localeBundles)[])('%s uses only plain staff words and the exact staff key set',lng=>{
  const copy = localeBundles[lng].orderSyncNotice;
  expect(Object.keys(copy).sort()).toEqual([...staffKeys].sort());
  for (const removed of ['keep', 'keepExplanation', 'confirmed']) { expect(copy).not.toHaveProperty(removed); }
  for (const text of Object.values(copy)) {
   expect(text.normalize('NFD').replace(/\p{M}/gu, '')).not.toMatch(bannedWords[lng]);
  }
 });
 it.each(Object.keys(localeBundles))('%s resolves every new key in its own language',async lng=>{const bundle=localeBundles[lng as keyof typeof localeBundles];const instance=i18next.createInstance();await instance.init({lng,fallbackLng:false,resources:{[lng]:{translation:bundle}},interpolation:{escapeValue:false}});for(const key of Object.keys(localeBundles.en.orderSyncNotice)){const path=`orderSyncNotice.${key}`;const text=instance.t(path,{number:'125',numbers:'125, 126'});expect(text).not.toBe(path);expect(text).not.toMatch(/\?{3,}|\uFFFD|\{\{/);expect(text.length).toBeGreaterThan(4);}});
 it('shows the unavailable check in Health without inventing a remedy',()=>{
  const result=buildSyncRecoveryIssues({systemHealth:{orderNoticeGate:{status:'unavailable',code:'UNCLASSIFIED_REFUSAL',refusal_count:1},syncBacklog:{},printerStatus:{configured:false}} as any});
  const issue=result.issues.find(issue=>issue.code==='issue_check_unavailable');
  expect(issue?.summaryKey).toBe('orderSyncNotice.checkUnavailableHealth');
  expect(issue?.actions.map(action=>action.id)).toEqual(['contactDev']);
 });
 it('lists both shipped remedies with one recommended action',()=>{const issue=customerCorrectionIssue(notice);expect(issue.actions.filter(a=>a.recommended)).toHaveLength(1);expect(issue.actions.every(a=>a.requiresOnline&&a.requiresSnapshot)).toBe(true);const matches=matchHealthRemedies({systemHealth:{orderNotices:[notice],syncBacklog:{},printerStatus:{configured:false}} as any},false,key=>key);for(const id of ['order-customer-correction.resend','order-customer-correction.keep-server']){expect(matches.find(m=>m.id===id)?.matches_now).toBe(true);}});
 it.each(Object.keys(localeBundles) as (keyof typeof localeBundles)[])('%s resolves both Health actions separately from the staff notice',lng=>{
  const issue=customerCorrectionIssue(notice);
  const keys=[issue.titleKey,issue.summaryKey,issue.guidanceKey,...issue.actions.flatMap(action=>[action.labelKey,action.descriptionKey])];
  for(const key of keys){
   expect(key).toMatch(/^recovery\.recipes\.orderCustomerCorrection\./);
   const value=key!.split('.').reduce((value:any,part)=>value?.[part],localeBundles[lng]);
   expect(typeof value).toBe('string');expect(value.length).toBeGreaterThan(4);
  }
  expect(issue.actions.map(action=>action.id)).toEqual(['resendOrderCustomerCorrection','keepServerOrderCustomerDetails']);
 });
 it('keeps a retry awaiting acknowledgement without offering another resend',()=>{const issue=customerCorrectionIssue({...notice,state:'pending'});expect(issue.status).toBe('recovering');expect(issue.actions).toHaveLength(0);});
 it('never calls a waiting payment healthy just because it has no failed-row recipe',()=>{const issues=orderRecoveryIssues([],'order',[{...notice,kind:'payment_not_on_server',actions:[]}],[],[]);expect(issues).toHaveLength(1);expect(issues[0].actions[0].id).toBe('contactDev');});
});
