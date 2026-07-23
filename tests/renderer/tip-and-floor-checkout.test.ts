import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const readSource = (...segments: string[]) =>
  readFileSync(path.join(projectRoot, ...segments), 'utf8');

test('customer address forms expose reusable floor presets without removing manual entry', () => {
  const addCustomer = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'AddCustomerModal.tsx',
  );
  const addAddress = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'AddNewAddressModal.tsx',
  );
  const presetPicker = readSource(
    'src',
    'renderer',
    'components',
    'forms',
    'FloorPresetPicker.tsx',
  );

  assert.match(addCustomer, /<FloorPresetPicker[\s\S]*value=\{formData\.floorNumber\}/);
  assert.match(addAddress, /<FloorPresetPicker[\s\S]*value=\{formData\.floorNumber\}/);
  assert.match(presetPicker, /BASEMENT|basement/i);
  assert.match(presetPicker, /GROUND|ground/i);
  assert.match(presetPicker, /type="text"/);
  assert.match(presetPicker, /preset\.wide \? 'col-span-2'/);
});

test('delivery customer forms require floor and ringer name and preserve saved address context', () => {
  const customerInfo = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'CustomerInfoModal.tsx',
  );
  const addCustomer = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'AddCustomerModal.tsx',
  );
  const editCustomer = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'EditCustomerInfoModal.tsx',
  );
  const deliveryValidation = readSource(
    'src',
    'renderer',
    'components',
    'delivery',
    'DeliveryValidationComponent.tsx',
  );

  for (const source of [customerInfo, addCustomer, editCustomer]) {
    assert.match(source, /floorRequired/);
    assert.match(source, /nameOnRingerRequired/);
  }
  assert.match(customerInfo, /initialAddress=\{customerInfo\.address\}/);
  assert.match(deliveryValidation, /addressInput:\s*initialAddress/);
  assert.match(deliveryValidation, /required\s+aria-required="true"/);
});

test('payment checkout treats tip as an auditable addition, not a payment method', () => {
  const paymentModal = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'PaymentModal.tsx',
  );
  const tipModal = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'TipModal.tsx',
  );

  assert.match(paymentModal, /<TipModal/);
  assert.match(paymentModal, /payableTotal/);
  assert.match(paymentModal, /tipAmount:\s*tipSelection\?\.amount/);
  assert.match(paymentModal, /tipRecipientRole:\s*tipSelection\?\.recipientRole/);
  assert.doesNotMatch(
    paymentModal,
    /type PaymentMethodSelection[^;]*tip/,
    'tip must not be represented as a tender type',
  );
  assert.match(tipModal, /\[5,\s*10,\s*15,\s*20\]/);
  assert.match(tipModal, /recipientRole/);
  assert.match(tipModal, /driver/);
  assert.match(tipModal, /waiter/);
  assert.match(tipModal, /cashier/);
});

test('all new-order paths persist tip financials and recipient attribution', () => {
  for (const relativePath of [
    ['src', 'renderer', 'components', 'OrderDashboard.tsx'],
    ['src', 'renderer', 'components', 'OrderFlow.tsx'],
    ['src', 'renderer', 'pages', 'NewOrderPage.tsx'],
  ]) {
    const source = readSource(...relativePath);
    assert.match(source, /tip_amount:\s*tipAmount/);
    assert.match(source, /tipAmount/);
    assert.match(source, /tipRecipientRole/);
    assert.match(source, /tipRecipientStaffId/);
  }
});

test('menu surface remains suppressed from payment selection through completion', () => {
  const menuModal = readSource(
    'src',
    'renderer',
    'components',
    'modals',
    'MenuModal.tsx',
  );

  assert.match(menuModal, /type CheckoutPhase = ['"]editing['"] \| ['"]payment['"] \| ['"]finishing['"]/);
  assert.match(menuModal, /setCheckoutPhase\(['"]finishing['"]\)/);
  assert.match(menuModal, /isOpen=\{isOpen && checkoutPhase === ['"]editing['"]\}/);
  assert.match(
    menuModal,
    /if \(checkoutPhase === ['"]payment['"]\) \{\s*setCheckoutPhase\(['"]editing['"]\)/,
  );
});
