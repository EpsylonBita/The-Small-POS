import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTwintManualConfiguration, configuredStoreCurrency } from '../TwintManualQrService';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn(), scope: { organizationId: 'org-a', branchId: '11111111-1111-4111-8111-111111111111', terminalId: 'terminal-a' } }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ adminApi: { fetchFromAdmin: mocks.fetch }, terminalConfig: { getSettings: mocks.settings } }) }));
vi.mock('../terminal-credentials', () => ({ getCachedTerminalCredentials: () => mocks.scope }));
const qr = 'data:image/png;base64,iVBORw0KGgo=';
const integration = () => ({ provider:'twint', plugin_id:'twint', branch_id:mocks.scope.branchId, is_purchased:true, is_enabled:true,
 settings:{environment:'production'}, payment_setup:{ integration_mode:'static_qr_manual', configuration_state:'manual_ready', reason_code:'TWINT_MANUAL_QR_READY',transport_ready:false,manual_confirmation_ready:true,currency:'CHF',qr_image_data:qr } });
const currencySettings = () => ({
 'terminal.branch_id': mocks.scope.branchId,
 'restaurant.store_currency_available': 'true',
 'restaurant.store_currency_source': 'branch_country',
 'restaurant.store_currency_branch_id': mocks.scope.branchId,
 'restaurant.currency': 'CHF',
 'organization.currency': 'EUR',
});
beforeEach(() => { mocks.scope.organizationId='org-a'; mocks.settings.mockResolvedValue(currencySettings()); mocks.fetch.mockResolvedValue({success:true,meta:{source:'remote'},data:{integrations:[integration()]}}); });
describe('Fresh TWINT manual eligibility', () => {
 it('accepts exactly the current entitled production branch and configured CHF', async () => { expect(await loadTwintManualConfiguration()).toEqual({qrImageData:qr,currency:'CHF',scope:`org-a|${mocks.scope.branchId}|terminal-a`}); });
 it.each(['unpurchased','disabled','test','foreign branch','Worldline','bad image','automatic mode'])('refuses %s configuration', async mode => {
  const item=integration();
  if(mode==='unpurchased') item.is_purchased=false;
  if(mode==='disabled') item.is_enabled=false;
  if(mode==='test') item.settings.environment='test';
  if(mode==='foreign branch') item.branch_id='22222222-2222-4222-8222-222222222222';
  if(mode==='Worldline') { item.provider='worldline_terminals'; item.plugin_id='worldline_terminals'; }
  if(mode==='bad image') item.payment_setup.qr_image_data='data:image/svg+xml;base64,PHN2Zz4=';
  if(mode==='automatic mode') item.payment_setup.integration_mode='worldline_terminal';
  mocks.fetch.mockResolvedValue({success:true,meta:{source:'remote'},data:{integrations:[item]}});
  expect(await loadTwintManualConfiguration()).toBeNull();
 });
 it.each(['cache','missing source','network','currency'])('fails closed after %s', async reason => {
  if(reason==='cache') mocks.fetch.mockResolvedValue({success:true,meta:{source:'cache',offlineFallback:true},data:{integrations:[integration()]}});
  if(reason==='missing source') mocks.fetch.mockResolvedValue({success:true,data:{integrations:[integration()]}});
  if(reason==='network') mocks.fetch.mockRejectedValue(new Error('network'));
  if(reason==='currency') mocks.settings.mockResolvedValue({'organization.currency':'EUR'});
  expect(await loadTwintManualConfiguration()).toBeNull();
 });
 it('drops a response from the previous organization', async () => {
  mocks.fetch.mockImplementation(async () => { mocks.scope.organizationId='org-b'; return {success:true,meta:{source:'remote'},data:{integrations:[integration()]}}; });
  expect(await loadTwintManualConfiguration()).toBeNull();
 });
 it('requires authoritative store country metadata and ignores stale organization currency', () => { expect(configuredStoreCurrency(currencySettings())).toBe('CHF'); expect(configuredStoreCurrency({'organization.currency':'EUR','terminal.currency':'CHF'})).toBeNull(); expect(configuredStoreCurrency({ ...currencySettings(), 'restaurant.store_currency_available': 'false' })).toBeNull(); });
});
