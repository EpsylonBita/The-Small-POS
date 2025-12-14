# Thermal Printer Setup Guide

This guide explains how to set up and use thermal printers with the POS system.

## Installation

### 1. Install the Printer Library

Due to native dependencies, you may need to use the `--legacy-peer-deps` flag:

```bash
cd pos-system
npm install node-thermal-printer --legacy-peer-deps
```

### 2. Install Printer Drivers

#### Windows
- Install the printer driver from the manufacturer (Epson, Star, etc.)
- Connect the printer via USB or configure network settings
- Note the printer name or COM port

#### macOS
- Install CUPS if not already installed
- Add the printer through System Preferences
- Note the printer name

#### Linux
- Install CUPS: `sudo apt-get install cups`
- Add the printer using CUPS web interface (http://localhost:631)
- Note the printer device path (e.g., `/dev/usb/lp0`)

## Configuration

### Printer Types Supported

- **EPSON**: ESC/POS compatible printers (TM-T88, TM-T20, etc.)
- **Star**: Star Micronics printers (TSP100, TSP650, etc.)
- **TANCA**: Tanca printers

### Connection Methods

#### USB Connection
```typescript
await printerService.initialize({
  type: 'epson',
  interface: '\\\\.\\COM3', // Windows
  // interface: '/dev/usb/lp0', // Linux
  // interface: '/dev/tty.usbserial', // macOS
  width: 48,
});
```

#### Network Connection (TCP/IP)
```typescript
await printerService.initialize({
  type: 'epson',
  interface: 'tcp://192.168.1.100', // Printer IP address
  width: 48,
});
```

#### Windows Printer Name
```typescript
await printerService.initialize({
  type: 'star',
  interface: 'printer:Star TSP100', // Printer name from Windows
  width: 48,
});
```

## Usage Examples

### Initialize Printer Service

```typescript
import { printerService } from '@/services/printer-service';

// Initialize on app startup
await printerService.initialize({
  type: 'epson',
  interface: 'tcp://192.168.1.100',
  width: 48,
  characterSet: 'PC437_USA',
});

// Test connection
const testResult = await printerService.testPrint();
if (!testResult) {
  console.error('Printer test failed');
}
```

### Print Customer Receipt

```typescript
const receiptData = {
  orderNumber: 'ORD-12345',
  orderType: 'dine-in' as const,
  timestamp: new Date(),
  items: [
    {
      name: 'Classic Crepe',
      quantity: 2,
      unitPrice: 8.99,
      total: 17.98,
      modifiers: ['Extra Nutella', 'Whipped Cream'],
    },
    {
      name: 'Caesar Salad',
      quantity: 1,
      unitPrice: 7.99,
      total: 7.99,
      specialInstructions: 'No croutons',
    },
  ],
  subtotal: 25.97,
  tax: 2.34,
  tip: 5.00,
  total: 33.31,
  paymentMethod: 'Credit Card',
  tableName: 'Table 5',
};

await printerService.printReceipt(receiptData);
```

### Print Kitchen Ticket

```typescript
const kitchenData = {
  orderNumber: 'ORD-12345',
  orderType: 'dine-in' as const,
  timestamp: new Date(),
  station: 'Grill',
  items: [
    {
      name: 'Classic Crepe',
      quantity: 2,
      unitPrice: 8.99,
      total: 17.98,
      modifiers: ['Extra Nutella', 'Whipped Cream'],
    },
  ],
  tableName: 'Table 5',
  specialInstructions: 'Customer allergic to nuts',
};

await printerService.printKitchenTicket(kitchenData);
```

## Integration with POS System

### In Main Process (Electron)

```typescript
// src/main/ipc-handlers.ts
import { ipcMain } from 'electron';
import { printerService } from '@/services/printer-service';

// Initialize printer on app start
ipcMain.handle('printer:initialize', async (_, config) => {
  await printerService.initialize(config);
  return { success: true };
});

// Print receipt
ipcMain.handle('printer:print-receipt', async (_, data) => {
  const success = await printerService.printReceipt(data);
  return { success };
});

// Print kitchen ticket
ipcMain.handle('printer:print-kitchen-ticket', async (_, data) => {
  const success = await printerService.printKitchenTicket(data);
  return { success };
});

// Test printer
ipcMain.handle('printer:test', async () => {
  const success = await printerService.testPrint();
  return { success };
});
```

### In Renderer Process (React)

```typescript
// src/renderer/hooks/use-printer.ts
export function usePrinter() {
  const printReceipt = async (data: ReceiptData) => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'printer:print-receipt',
        data
      );
      return result.success;
    } catch (error) {
      console.error('Failed to print receipt:', error);
      return false;
    }
  };

  const printKitchenTicket = async (data: KitchenTicketData) => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'printer:print-kitchen-ticket',
        data
      );
      return result.success;
    } catch (error) {
      console.error('Failed to print kitchen ticket:', error);
      return false;
    }
  };

  return { printReceipt, printKitchenTicket };
}
```

### In Component

```typescript
import { usePrinter } from '@/hooks/use-printer';

function CheckoutScreen() {
  const { printReceipt } = usePrinter();

  const handleCompleteOrder = async (order: Order) => {
    // Process payment...

    // Print receipt
    const receiptData = {
      orderNumber: order.id,
      orderType: order.type,
      timestamp: new Date(order.created_at),
      items: order.items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        total: item.quantity * item.unit_price,
        modifiers: item.modifiers,
        specialInstructions: item.special_instructions,
      })),
      subtotal: order.subtotal,
      tax: order.tax,
      tip: order.tip,
      total: order.total,
      paymentMethod: order.payment_method,
    };

    const success = await printReceipt(receiptData);
    if (!success) {
      alert('Failed to print receipt');
    }
  };

  return (
    // Your component JSX
  );
}
```

## Troubleshooting

### Printer Not Found

1. Check printer is powered on and connected
2. Verify connection method (USB/Network)
3. Check printer drivers are installed
4. Try running test print from printer utility

### Print Quality Issues

- Check paper roll is installed correctly
- Clean print head
- Check paper type matches printer specs
- Adjust print density in printer settings

### Network Printer Not Responding

- Verify IP address is correct
- Check firewall settings
- Ensure printer and computer are on same network
- Try pinging the printer: `ping 192.168.1.100`

### USB Printer Permission Denied (Linux)

```bash
# Add user to lp group
sudo usermod -a -G lp $USER

# Or add udev rule
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", MODE="0666"' | sudo tee /etc/udev/rules.d/99-printer.rules
sudo udevadm control --reload-rules
```

## Recommended Printers

### Budget-Friendly
- **Epson TM-T20III** - USB/Ethernet, reliable, good speed
- **Star TSP143IIIU** - USB, compact, fast

### Professional
- **Epson TM-T88VI** - USB/Ethernet/Bluetooth, high speed, excellent reliability
- **Star TSP654II** - USB/Ethernet, dual-sided printing

### Kitchen Printers
- **Epson TM-T88V-iHub** - Network-connected, rugged, moisture-resistant
- **Star SP700** - Impact printer for kitchen environments

## Configuration File

Create a `printer-config.json` in POS system settings:

```json
{
  "receipt_printer": {
    "type": "epson",
    "interface": "tcp://192.168.1.100",
    "width": 48,
    "enabled": true
  },
  "kitchen_printers": [
    {
      "name": "Grill Station",
      "type": "epson",
      "interface": "tcp://192.168.1.101",
      "width": 48,
      "enabled": true
    },
    {
      "name": "Prep Station",
      "type": "epson",
      "interface": "tcp://192.168.1.102",
      "width": 48,
      "enabled": true
    }
  ],
  "auto_print_receipt": true,
  "auto_print_kitchen_ticket": true,
  "print_on_order_complete": true
}
```

## Support

For issues with specific printer models, consult:
- [node-thermal-printer GitHub](https://github.com/Klemen1337/node-thermal-printer)
- Printer manufacturer documentation
- ESC/POS command reference
