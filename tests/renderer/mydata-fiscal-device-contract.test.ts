import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const integrationsSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'IntegrationsPage.tsx'),
  'utf8',
);
const ordersCommandSource = readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'orders.rs'),
  'utf8',
);
const ecrCommandSource = readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'ecr.rs'),
  'utf8',
);

const locale = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${name}.json`), 'utf8'));

const REQUIRED_KEYS = [
  'network',
  'networkHost',
  'networkPort',
  'networkPortPlaceholder',
  'deviceBrand',
  'deviceModel',
  'protocolProfile',
  'testingLocally',
  'protocolVerified',
  'transportOnly',
  'verificationRequired',
];

test('MyData fiscal-device setup supports LAN and performs a native protocol test', () => {
  assert.match(
    integrationsSource,
    /'usb_serial'\s*\|\s*'bluetooth'\s*\|\s*'network'/,
    'MyData connection type must include network',
  );
  assert.match(integrationsSource, /bridge\.ecr\.(addDevice|updateDevice)/);
  assert.match(integrationsSource, /bridge\.ecr\.connectDevice/);
  assert.match(integrationsSource, /bridge\.ecr\.testConnection/);
  assert.match(integrationsSource, /protocol_handshake/);
  assert.match(integrationsSource, /isMyDataFiscalDeviceMode\s*&&/);
  assert.match(
    integrationsSource,
    /myDataConfig\.mode === ['"]fiscal_device['"]\) return;[\s\S]{0,1500}updateDevice\(MYDATA_FISCAL_DEVICE_ID,[\s\S]{0,200}enabled:\s*false/,
    'managed cashier must be disabled after switching to a provider/direct mode',
  );
});

test('MyData fiscal-device labels exist in every POS locale', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const values = locale(language).integrations?.mydata;
    assert.ok(values, `${language}.integrations.mydata missing`);
    for (const key of REQUIRED_KEYS) {
      const value = key === 'network'
        ? values.connectionTypes?.network
        : values[key];
      assert.equal(typeof value, 'string', `${language}.integrations.mydata.${key} missing`);
      assert.ok(value.trim().length > 0, `${language}.integrations.mydata.${key} empty`);
    }
  }
});

test('initial checkout waits for fiscal approval before order and payment persistence', () => {
  const checkoutCommandAt = ordersCommandSource.indexOf(
    'pub async fn order_create_with_initial_payment',
  );
  const checkoutCommandSource = ordersCommandSource.slice(checkoutCommandAt);
  const checkoutAt = checkoutCommandSource.indexOf('fiscal_checkout_for_order_payload');
  const createAt = checkoutCommandSource.indexOf('sync::create_order(&db, &normalized, &app)');
  assert.ok(checkoutCommandAt >= 0, 'initial-payment command missing');
  assert.ok(checkoutAt >= 0, 'native fiscal checkout orchestration missing');
  assert.ok(createAt > checkoutAt, 'order must only be created after fiscal approval');
  assert.match(
    checkoutCommandSource,
    /fiscal_checkout_for_order_payload[\s\S]*Err\(error\)[\s\S]*"errorCode": "FISCAL_CHECKOUT_NOT_APPROVED"[\s\S]*sync::create_order/,
    'all fiscal pre-check errors must block Admin/offline fallback before persistence',
  );
  assert.match(checkoutCommandSource, /"paymentApproved": false/);
  assert.match(checkoutCommandSource, /"terminalApproved".*true/s);
  assert.match(ecrCommandSource, /TransactionStatus::Approved/);
  assert.match(ecrCommandSource, /alreadyIssued/);
  assert.doesNotMatch(ecrCommandSource, /SELECT data FROM orders/);
  assert.doesNotMatch(ecrCommandSource, /SELECT data FROM order_payments/);
});

test('fiscal plugin does not claim RBS uses the bundled legacy protocol', () => {
  const genericProtocolSource = readFileSync(
    path.join(process.cwd(), 'src-tauri', 'src', 'ecr', 'protocols', 'generic_fiscal.rs'),
    'utf8',
  );
  assert.doesNotMatch(
    genericProtocolSource,
    /covers most fiscal[\s\S]*RBS/i,
    'the legacy STX/ETX profile must not be advertised as an RBS driver',
  );

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const values = locale(language).settings?.peripherals?.cashRegister;
    for (const key of [
      'protocolRequired',
      'protocolUnconfigured',
      'legacyDatecsProtocol',
      'tcpPortRequired',
      'rbsNetworkHint',
    ]) {
      assert.equal(typeof values?.[key], 'string', `${language}.cashRegister.${key} missing`);
      assert.ok(values[key].trim().length > 0, `${language}.cashRegister.${key} empty`);
    }
  }
});
