import { describe, expect, it } from 'vitest';
import { streetNamesDiffer } from '../address-street-name';

describe('streetNamesDiffer', () => {
  it.each([
    ['Κωνσταντινουπόλεως 6', 'Γιάννη Χαλκίδη', true],
    ['Κωνσταντινουπόλεως 62', 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ', false],
    ['Λεωφ. Βασ. Όλγας 12', 'Λεωφόρος Βασιλίσσης Όλγας', false],
    ['Λεωφόρος Βασιλίσσης Όλγας 12', 'Λεωφ. Βασ. Όλγας', false],
    ['Οδ. Αγίου Δημητρίου 62Α', 'Οδός Αγί. Δημητρίου', false],
    ['Πλ. Αριστοτέλους 1', 'Πλατεία Αριστοτέλους', false],
    ['Λ. Νίκης 12-14', 'Νίκης', false],
    ['St. Test 12', 'Test Street', false],
    ['Test Rd 12', 'Test Road', false],
    ['Test Ave 12', 'Test Avenue', false],
    ['Rue Émile-Zola 12', 'Émile Zola', false],
    ['Via Roma 12', 'Viale Roma', false],
    ['Piazza Roma 12', 'Roma', false],
    ['Hauptstraße 12', 'Hauptstrasse', false],
    ['Str. Test 12', 'Test Strasse', false],
    ['Rr. Test 12', 'Rruga Test', false],
    ['Test 12', 'Test Additional Name', false],
    ['Abc 12', 'Abcdef', false],
    ['Ab 12', 'Abcdef', true],
    ['Test 12', undefined, false],
    ['Test 12', '', false],
    ['Οδός 12', 'Γιάννη Χαλκίδη', false],
    ['Test 12', 'Street', false],
  ])('%s compared with %s differs: %s', (text, route, differs) => {
    expect(streetNamesDiffer(text, route)).toBe(differs);
  });
});
