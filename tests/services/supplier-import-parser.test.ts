import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSupplierMetadataFromText,
  parsePositionedSupplierRows,
  type SupplierPdfTextToken,
} from '../../src/renderer/utils/supplier-import-parser';

test('supplier import parser extracts Greek invoice rows from positioned PDF text', () => {
  const tokens: SupplierPdfTextToken[] = [
    { page: 1, x: 24, y: 507, text: '04-042' },
    { page: 1, x: 74, y: 507, text: 'ΜΑΓΙΟΝΕΖΑ ΒΑΣΗ' },
    { page: 1, x: 143, y: 507, text: 'QFS' },
    { page: 1, x: 291, y: 507, text: 'ΚΙΛ' },
    { page: 1, x: 328, y: 507, text: '12,000' },
    { page: 1, x: 381, y: 507, text: '2,400' },
    { page: 1, x: 418, y: 507, text: '28,80' },
    { page: 1, x: 24, y: 461, text: '03-060' },
    { page: 1, x: 74, y: 461, text: 'ΦΡΕΣΚΟ ΤΥΡΙ ΚΡΕΜΑ 26%' },
    { page: 1, x: 174, y: 461, text: '1.5 ΚΙΛΩΝ' },
    { page: 1, x: 290, y: 461, text: 'ΤΕΜ' },
    { page: 1, x: 330, y: 461, text: '1,000' },
    { page: 1, x: 381, y: 461, text: '8,800' },
  ];

  assert.deepEqual(parsePositionedSupplierRows(tokens), [
    {
      name: 'ΜΑΓΙΟΝΕΖΑ ΒΑΣΗ QFS',
      sku: '04-042',
      barcode: '',
      quantity: 12,
      unit: 'ΚΙΛ',
      cost: 2.4,
      minStockLevel: 0,
      category: '',
      subcategory: '',
      notes: '',
    },
    {
      name: 'ΦΡΕΣΚΟ ΤΥΡΙ ΚΡΕΜΑ 26% 1.5 ΚΙΛΩΝ',
      sku: '03-060',
      barcode: '',
      quantity: 1,
      unit: 'ΤΕΜ',
      cost: 8.8,
      minStockLevel: 0,
      category: '',
      subcategory: '',
      notes: '',
    },
  ]);
});

test('supplier import parser extracts supplier header metadata from Greek invoice text', () => {
  const metadata = parseSupplierMetadataFromText(`
ΠΑΣΧ. ΠΕΤΡΑΚΟΓΛΟΥ-ΚΥΡ. ΜΠΕΚΙΑΡΗΣ Ο.Ε                                 400013573185604
ΕΜΠΟΡΙΑ ΤΡΟΦΙΜΩΝ
ΒΙΠΑ ΝΕΟΧΩΡΟΥΔΑΣ - ΘΕΣ/ΝΙΚΗ
ΤΗΛ.: 2310-567930 & FAX 2310567938 & Viber: 6970968944
ΑΦΜ 998000672 & ΔΟΥ ΙΩΝΙΑΣ ΘΕΣΣΑΛΟΝΙΚΗΣ
Site: www.qfs.com.gr - email: info@qfs.com.gr
ΕΙΔΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ ΑΡΙΘΜΟΣ ΗΜΕΡΟΜΗΝΙΑ
Τιμολόγιο Δελτίο Αποστολής - Σειρά Β 12365 15/5/2026 00ΤΔΑ
ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ
ΕΠΩΝΥΜΙΑ: ΜΙΚΡΟ ΠΑΡΙΣΙ 2026 Ε Ε
ΤΡΟΠΟΣ ΠΛΗΡΩΜΗΣ: ΕΠΙ ΠΙΣΤΩΣΕΙ
`);

  assert.equal(metadata?.name, 'ΠΑΣΧ. ΠΕΤΡΑΚΟΓΛΟΥ-ΚΥΡ. ΜΠΕΚΙΑΡΗΣ Ο.Ε');
  assert.equal(metadata?.email, 'info@qfs.com.gr');
  assert.equal(metadata?.phone, '2310-567930');
  assert.equal(metadata?.taxId, '998000672');
  assert.equal(metadata?.invoiceNumber, '12365');
  assert.equal(metadata?.invoiceDate, '15/5/2026');
  assert.match(metadata?.notes || '', /VAT: 998000672/);
});
