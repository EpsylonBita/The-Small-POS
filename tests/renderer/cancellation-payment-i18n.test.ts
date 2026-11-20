import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const localesDir = path.join(process.cwd(), 'src', 'locales');
const languages = ['el', 'en', 'de', 'fr', 'it', 'sq'] as const;
const expectedPlaceholders = {
  driverCash: ['amount', 'name'],
  driverCashNoName: ['amount'],
  paymentInReview: [],
  checkPayments: [],
};

const expectedCashCheck = {
  el: "Αυτή η παραγγελία έχει καταγραμμένα μετρητά. Ελέγξτε αν τα μετρητά εισπράχθηκαν ή επιστράφηκαν, πριν διορθώσετε την πληρωμή.",
  en: "This order has a recorded cash payment. Check whether the cash was received or returned before correcting the payment.",
  de: "Für diese Bestellung ist eine Barzahlung erfasst. Prüfen Sie, ob das Bargeld eingenommen oder zurückgegeben wurde, bevor Sie die Zahlung korrigieren.",
  fr: "Un paiement en espèces est enregistré pour cette commande. Vérifiez si les espèces ont été encaissées ou rendues avant de corriger le paiement.",
  it: "Per questo ordine è registrato un pagamento in contanti. Controlla se i contanti sono stati incassati o restituiti prima di correggere il pagamento.",
  sq: "Për këtë porosi është regjistruar një pagesë në para në dorë. Kontrollo nëse paratë u arkëtuan ose u kthyen para se të korrigjosh pagesën.",
};

interface LocaleLayer {
  cancellationNotice?: Record<string, string>;
  modals?: { staffShift?: { platformCash?: unknown } };
  paymentIntegrity?: { driverCheckoutNote?: unknown; driverCheckoutNoteWithoutName?: unknown };
}

function readLocale(file: string): LocaleLayer {
  const bytes = readFileSync(path.join(localesDir, file));
  assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), file);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

for (const language of languages) {
  test(`cancellation payment wording and removed Checkout keys in ${language}`, () => {
    const layers = [
      readLocale(`${language}.json`),
      readLocale(`overlays/${language}.sync-hotfix.json`),
      readLocale(`overlays/${language}.platforms.json`),
    ];
    for (const layer of layers) {
      assert.equal(layer.modals?.staffShift?.platformCash, undefined);
      assert.equal(layer.paymentIntegrity?.driverCheckoutNote, undefined);
      assert.equal(layer.paymentIntegrity?.driverCheckoutNoteWithoutName, undefined);
    }
    const wording = layers[2].cancellationNotice;
    assert.ok(wording);
    assert.equal(wording.checkPayments, expectedCashCheck[language]);
    for (const [key, placeholders] of Object.entries(expectedPlaceholders)) {
      const value: unknown = new Map(Object.entries(wording)).get(key);
      assert.ok(typeof value === 'string' && value.trim(), key);
      assert.deepEqual(Array.from(String(value).matchAll(/\{\{(\w+)\}\}/g), match => match[1]).sort(), placeholders, key);
    }
  });
}
