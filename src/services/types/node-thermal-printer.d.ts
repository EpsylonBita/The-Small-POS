// Minimal ambient typings for the optional `node-thermal-printer` dependency.
// This is intentionally loose: the runtime implementation is authoritative;
// these types simply make TypeScript happy when the library is present.

declare module 'node-thermal-printer' {
  export const PrinterTypes: any;

  export class ThermalPrinter {
    constructor(config: any);
    isPrinterConnected?(): Promise<boolean> | boolean;
    printText?(text: string): void;
    println?(text: string): void;
    alignCenter?(): void;
    alignLeft?(): void;
    setTextSize?(width: number, height: number): void;
    bold?(on: boolean): void;
    drawLine?(): void;
    newLine?(): void;
    printQR?(data: string, options?: any): void;
    cut?(): void;
    execute?(): Promise<any>;
    [key: string]: any;
  }
}

