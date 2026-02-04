/**
 * Label Print IPC Handlers
 *
 * Handles label printing requests via IPC.
 * Routes requests through LabelGenerator for ESC/POS thermal printing.
 */

import { ipcMain } from 'electron';
import { getPrinterManagerInstance } from '../printer-manager-handlers';
import { LabelGenerator, type LabelProduct, type BarcodeLabelOptions, type ShelfLabelOptions, type PriceTagOptions } from '../../printer/services/escpos/LabelGenerator';
import { PaperSize, PrintJobType } from '../../printer/types';
import type { BarcodeType } from '@shared/types/product';

// =============================================================================
// Types
// =============================================================================

interface BarcodeLabelRequest {
    type: 'barcode';
    barcode: string;
    barcodeType?: BarcodeType;
    productName: string;
    productPrice?: number;
    showName?: boolean;
    showPrice?: boolean;
    quantity?: number;
    size?: 'small' | 'medium' | 'large';
}

interface ShelfLabelRequest {
    type: 'shelf';
    productName: string;
    productSku?: string;
    productPrice: number;
    productDescription?: string;
    barcode?: string;
    barcodeType?: BarcodeType;
    template?: 'standard' | 'compact' | 'detailed' | 'price-focus';
    quantity?: number;
}

interface PriceLabelRequest {
    type: 'price';
    productName: string;
    price: number;
    oldPrice?: number;
    showSaleIndicator?: boolean;
    barcode?: string;
    barcodeType?: BarcodeType;
    quantity?: number;
}

type LabelRequest = BarcodeLabelRequest | ShelfLabelRequest | PriceLabelRequest;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert label size to barcode options
 */
function sizeToOptions(size: 'small' | 'medium' | 'large' = 'medium'): Partial<BarcodeLabelOptions> {
    switch (size) {
        case 'small':
            return { barcodeHeight: 50, barcodeWidth: 2 };
        case 'large':
            return { barcodeHeight: 100, barcodeWidth: 4 };
        default:
            return { barcodeHeight: 80, barcodeWidth: 3 };
    }
}

/**
 * Convert template to shelf label options
 */
function templateToOptions(template: string = 'standard'): Partial<ShelfLabelOptions> {
    switch (template) {
        case 'compact':
            return { showSku: false, showDescription: false, showBarcode: true, largePriceFont: false };
        case 'detailed':
            return { showSku: true, showDescription: true, showBarcode: true, largePriceFont: true };
        case 'price-focus':
            return { showSku: false, showDescription: false, showBarcode: true, largePriceFont: true };
        default: // standard
            return { showSku: false, showDescription: false, showBarcode: true, largePriceFont: true };
    }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * Register label print IPC handlers
 */
export function registerLabelPrintHandlers(): void {
    /**
     * Print a label (barcode, shelf, or price)
     *
     * Usage from renderer:
     *   window.electronAPI.printLabel({ type: 'barcode', barcode: '1234567890123', productName: 'Test Product' })
     */
    ipcMain.handle('label:print', async (_event, request: LabelRequest, printerId?: string) => {
        try {
            console.log('[label:print] Received request:', request.type);

            const printerManager = getPrinterManagerInstance();
            if (!printerManager) {
                return { success: false, error: 'PrinterManager not initialized' };
            }

            // Find appropriate printer (label printer or receipt printer)
            const printers = printerManager.getPrinters();
            let targetPrinter = printerId
                ? printers.find(p => p.id === printerId && p.enabled)
                : printers.find(p => p.role === 'label' && p.enabled) || printers.find(p => p.role === 'receipt' && p.enabled);

            if (!targetPrinter) {
                targetPrinter = printers.find(p => p.enabled);
            }

            if (!targetPrinter) {
                return { success: false, error: 'No enabled printer found' };
            }

            console.log(`[label:print] Using printer: ${targetPrinter.name}`);

            // Determine paper size from printer config
            const paperSize = targetPrinter.paperSize || PaperSize.MM_80;
            const generator = new LabelGenerator(paperSize);

            let printBuffer: Buffer;

            switch (request.type) {
                case 'barcode': {
                    const product: LabelProduct = {
                        name: request.productName,
                        barcode: request.barcode,
                        barcodeType: request.barcodeType,
                        price: request.productPrice || 0,
                    };

                    const options: BarcodeLabelOptions = {
                        showName: request.showName ?? true,
                        showPrice: request.showPrice ?? false,
                        quantity: request.quantity ?? 1,
                        ...sizeToOptions(request.size),
                    };

                    printBuffer = generator.generateBarcodeLabel(product, options);
                    break;
                }

                case 'shelf': {
                    const product: LabelProduct = {
                        name: request.productName,
                        sku: request.productSku,
                        barcode: request.barcode,
                        barcodeType: request.barcodeType,
                        price: request.productPrice,
                        description: request.productDescription,
                    };

                    const options: ShelfLabelOptions = {
                        quantity: request.quantity ?? 1,
                        ...templateToOptions(request.template),
                    };

                    printBuffer = generator.generateShelfLabel(product, options);
                    break;
                }

                case 'price': {
                    const product: LabelProduct = {
                        name: request.productName,
                        barcode: request.barcode,
                        barcodeType: request.barcodeType,
                        price: request.price,
                    };

                    const options: PriceTagOptions = {
                        quantity: request.quantity ?? 1,
                        showOldPrice: request.oldPrice !== undefined,
                        oldPrice: request.oldPrice,
                        showSaleIndicator: request.showSaleIndicator ?? false,
                    };

                    printBuffer = generator.generatePriceTag(product, options);
                    break;
                }

                default:
                    return { success: false, error: `Unknown label type: ${(request as LabelRequest).type}` };
            }

            console.log(`[label:print] Generated ${printBuffer.length} bytes for ${request.type} label`);

            // Submit print job
            const result = await printerManager.submitPrintJob({
                id: `label-${Date.now()}`,
                type: PrintJobType.LABEL,
                data: { buffer: printBuffer },
                priority: 1,
                createdAt: new Date(),
            });

            return result;
        } catch (error) {
            console.error('[label:print] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to print label',
            };
        }
    });

    /**
     * Print batch labels for multiple products
     *
     * Usage from renderer:
     *   window.electronAPI.printBatchLabels([
     *     { product: { name: 'Product 1', barcode: '123' }, quantity: 5 },
     *     { product: { name: 'Product 2', barcode: '456' }, quantity: 3 },
     *   ], 'barcode')
     */
    ipcMain.handle('label:print-batch', async (_event, items: Array<{ product: LabelProduct; quantity: number }>, labelType: 'barcode' | 'shelf' | 'price' = 'barcode', printerId?: string) => {
        try {
            console.log(`[label:print-batch] Received batch request: ${items.length} items, type: ${labelType}`);

            const printerManager = getPrinterManagerInstance();
            if (!printerManager) {
                return { success: false, error: 'PrinterManager not initialized' };
            }

            const printers = printerManager.getPrinters();
            let targetPrinter = printerId
                ? printers.find(p => p.id === printerId && p.enabled)
                : printers.find(p => p.role === 'label' && p.enabled) || printers.find(p => p.role === 'receipt' && p.enabled);

            if (!targetPrinter) {
                targetPrinter = printers.find(p => p.enabled);
            }

            if (!targetPrinter) {
                return { success: false, error: 'No enabled printer found' };
            }

            const paperSize = targetPrinter.paperSize || PaperSize.MM_80;
            const generator = new LabelGenerator(paperSize);

            const printBuffer = generator.generateBatchLabels(items, labelType);

            console.log(`[label:print-batch] Generated ${printBuffer.length} bytes for batch labels`);

            const result = await printerManager.submitPrintJob({
                id: `batch-label-${Date.now()}`,
                type: PrintJobType.LABEL,
                data: { buffer: printBuffer },
                priority: 1,
                createdAt: new Date(),
            });

            return result;
        } catch (error) {
            console.error('[label:print-batch] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to print batch labels',
            };
        }
    });

    console.log('[LabelPrintHandlers] Label print IPC handlers registered');
}
