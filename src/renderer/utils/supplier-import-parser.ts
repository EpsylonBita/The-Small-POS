export interface SupplierImportParsedRow {
  name: string;
  nameEl?: string | null;
  sku?: string | null;
  barcode?: string | null;
  quantity: number;
  unit: string;
  cost: number;
  minStockLevel?: number;
  category?: string | null;
  subcategory?: string | null;
  notes?: string | null;
}

export interface SupplierPdfTextToken {
  page: number;
  text: string;
  x: number;
  y: number;
}

export interface SupplierImportParsedSupplier {
  name?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  address?: string | null;
  paymentTerms?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  notes?: string | null;
}

export interface SupplierImportParsedFile {
  rows: SupplierImportParsedRow[];
  supplier?: SupplierImportParsedSupplier | null;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value
      .trim()
      .replace(/\./g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function splitDelimitedLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map(part => part.trim());
  if (line.includes(';')) return line.split(';').map(part => part.trim());
  return line.split(',').map(part => part.trim());
}

export function parseSupplierRowsFromText(text: string): SupplierImportParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstColumns = splitDelimitedLine(lines[0]);
  const hasHeader = firstColumns.some(column => /name|item|sku|barcode|qty|quantity|cost|category/i.test(column));
  const headers = hasHeader
    ? firstColumns.map(column => column.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    : ['name', 'sku', 'barcode', 'quantity', 'unit', 'cost', 'category', 'subcategory'];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line): SupplierImportParsedRow | null => {
      const columns = splitDelimitedLine(line);
      const read = (...keys: string[]) => {
        const index = headers.findIndex(header => keys.includes(header));
        return index >= 0 ? columns[index] || '' : '';
      };
      const name = read('name', 'item', 'itemname', 'product', 'description');
      const barcode = read('barcode', 'ean', 'code');
      const sku = read('sku', 'itemcode', 'productcode');
      if (!name && !barcode && !sku) return null;

      return {
        name: name || (barcode ? `Item ${barcode}` : sku),
        sku,
        barcode,
        quantity: Math.max(1, toNumber(read('quantity', 'qty', 'stock'), 1)),
        unit: read('unit', 'uom') || 'pcs',
        cost: Math.max(0, toNumber(read('cost', 'price', 'unitcost'), 0)),
        minStockLevel: Math.max(0, toNumber(read('minstock', 'minstocklevel', 'minimum'), 0)),
        category: read('category'),
        subcategory: read('subcategory', 'subcat'),
        notes: read('notes'),
      };
    })
    .filter((row): row is SupplierImportParsedRow => Boolean(row));
}

function groupTokensIntoRows(tokens: SupplierPdfTextToken[]) {
  const byPage = new Map<number, SupplierPdfTextToken[]>();
  for (const token of tokens) {
    const pageTokens = byPage.get(token.page) || [];
    pageTokens.push(token);
    byPage.set(token.page, pageTokens);
  }

  const rows: SupplierPdfTextToken[][] = [];
  for (const pageTokens of byPage.values()) {
    const sorted = [...pageTokens].sort((a, b) => Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x);
    for (const token of sorted) {
      const existing = rows.find(row => row[0]?.page === token.page && Math.abs((row[0]?.y || 0) - token.y) <= 2.5);
      if (existing) {
        existing.push(token);
      } else {
        rows.push([token]);
      }
    }
  }

  return rows.map(row => [...row].sort((a, b) => a.x - b.x));
}

function isLikelyItemCode(value: string): boolean {
  return /^[A-ZΑ-Ω0-9]{1,4}[-/][A-ZΑ-Ω0-9]{1,8}$/i.test(value.trim());
}

function joinText(tokens: SupplierPdfTextToken[]): string {
  return tokens.map(token => token.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function tokensToText(tokens: SupplierPdfTextToken[]): string {
  return groupTokensIntoRows(tokens)
    .map(row => joinText(row))
    .filter(Boolean)
    .join('\n');
}

function cleanHeaderLine(line: string): string {
  return line.replace(/\s+\d{10,}.*$/, '').replace(/\s+/g, ' ').trim();
}

function matchFirst(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function parseSupplierMetadataFromText(text: string): SupplierImportParsedSupplier | null {
  const lines = text
    .split(/\r?\n/)
    .map(line => cleanHeaderLine(line))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const firstDocumentLine = lines.findIndex(line => /ΕΙΔΟΣ\s+ΠΑΡΑΣΤΑΤΙΚΟΥ|ΣΤΟΙΧΕΙΑ\s+ΠΕΛΑΤΗ|ΚΩΔΙΚΟΣ\s+ΠΕΡΙΓΡΑΦΗ/i.test(line));
  const headerLines = lines.slice(0, firstDocumentLine > 0 ? firstDocumentLine : Math.min(lines.length, 12));
  const supplierName = headerLines.find(line =>
    /[A-ZΑ-Ω]/i.test(line) &&
    !/^(ΕΜΠΟΡΙΑ|Τ\.Θ\.|ΒΙΠΑ|ΤΗΛ|ΑΦΜ|SITE|EMAIL|ΓΕΜΗ)/i.test(line)
  ) || null;
  const email = matchFirst(text, [/\bemail\s*:\s*([^\s]+)/i, /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i]);
  const phone = matchFirst(text, [/ΤΗΛ\.?\s*:?\s*([0-9+\-\s&]+?)(?:FAX|Viber|ΑΦΜ|$)/i, /\b(?:tel|phone)\.?\s*:?\s*([0-9+\-\s]+)/i]);
  const taxId = matchFirst(text, [/Α\.?Φ\.?Μ\.?\s*:?\s*([0-9]{7,})/i, /\bVAT\s*:?\s*([A-Z0-9]+)/i]);
  const paymentTerms = matchFirst(text, [/ΤΡΟΠΟΣ\s+ΠΛΗΡΩΜΗΣ\s*:?\s*([^\n]+)/i, /\bpayment\s+terms\s*:?\s*([^\n]+)/i]);
  const invoiceLineIndex = lines.findIndex(line => /Τιμολόγιο|Invoice/i.test(line));
  const invoiceLine = invoiceLineIndex >= 0 ? lines[invoiceLineIndex] : '';
  const invoiceWindow = invoiceLineIndex >= 0
    ? lines.slice(Math.max(0, invoiceLineIndex - 2), invoiceLineIndex + 3).join(' ')
    : text;
  const invoiceNumber = invoiceLine.match(/\b(\d{3,})\b/)?.[1] || matchFirst(text, [/ΑΡΙΘΜΟΣ\s*:?\s*(\d{3,})/i]);
  const invoiceDate = invoiceWindow.match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] || matchFirst(text, [/ΗΜΕΡΟΜΗΝΙΑ\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i]);
  const address = headerLines.find(line => /ΒΙΠΑ|Τ\.Θ\.|ΟΔΟΣ|ΛΕΩΦ|ΘΕΣ\/ΝΙΚΗ|ΘΕΣΣΑΛΟΝΙΚ/i.test(line)) || null;

  const notes = [
    taxId ? `VAT: ${taxId}` : null,
    address ? `Address: ${address}` : null,
    paymentTerms ? `Payment: ${paymentTerms}` : null,
    invoiceNumber ? `Invoice: ${invoiceNumber}${invoiceDate ? ` - ${invoiceDate}` : ''}` : null,
  ].filter(Boolean).join(' | ');

  if (!supplierName && !email && !phone && !taxId) return null;

  return {
    name: supplierName,
    contactPerson: null,
    email,
    phone: phone?.replace(/\s+/g, ' ').replace(/[&,\s]+$/, '') || null,
    taxId,
    address,
    paymentTerms,
    invoiceNumber,
    invoiceDate,
    notes: notes || null,
  };
}

export function parsePositionedSupplierRows(tokens: SupplierPdfTextToken[]): SupplierImportParsedRow[] {
  const rows = groupTokensIntoRows(tokens);
  const parsed: SupplierImportParsedRow[] = [];

  for (const row of rows) {
    const code = row.find(token => token.x < 70 && isLikelyItemCode(token.text));
    if (!code) continue;

    const description = joinText(row.filter(token => token.x >= 65 && token.x < 285));
    const unit = joinText(row.filter(token => token.x >= 285 && token.x < 315));
    const quantity = joinText(row.filter(token => token.x >= 315 && token.x < 365));
    const unitCost = joinText(row.filter(token => token.x >= 365 && token.x < 410));

    if (!description || !unit || !quantity) continue;

    parsed.push({
      name: description,
      sku: code.text.trim(),
      barcode: '',
      quantity: Math.max(0, toNumber(quantity, 0)),
      unit: unit || 'pcs',
      cost: Math.max(0, toNumber(unitCost, 0)),
      minStockLevel: 0,
      category: '',
      subcategory: '',
      notes: '',
    });
  }

  return parsed;
}

async function extractPdfTokens(file: File): Promise<SupplierPdfTextToken[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({
    data,
    disableWorker: typeof window === 'undefined',
    useSystemFonts: true,
  } as any).promise;
  const tokens: SupplierPdfTextToken[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const transform = item.transform as number[];
      tokens.push({
        page: pageNumber,
        text: item.str.trim(),
        x: transform[4] || 0,
        y: transform[5] || 0,
      });
    }
  }

  return tokens;
}

export async function extractSupplierImportFile(file: File): Promise<SupplierImportParsedFile> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (extension === 'pdf') {
    const tokens = await extractPdfTokens(file);
    const text = tokensToText(tokens);
    const positionedRows = parsePositionedSupplierRows(tokens);
    if (positionedRows.length > 0) {
      return {
        rows: positionedRows,
        supplier: parseSupplierMetadataFromText(text),
      };
    }
  }

  const text = await file.text().catch(() => '');
  return {
    rows: parseSupplierRowsFromText(text),
    supplier: parseSupplierMetadataFromText(text),
  };
}

export async function extractSupplierImportRowsFromFile(file: File): Promise<SupplierImportParsedRow[]> {
  const parsedFile = await extractSupplierImportFile(file);
  return parsedFile.rows;
}
