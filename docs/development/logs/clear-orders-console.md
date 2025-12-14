# Clear All Orders - Console Command

## How to Clear All Orders from POS System

Since the Node.js script has module version conflicts, use the browser console instead:

### Steps:

1. **Open the POS app**
2. **Open DevTools** (Press `F12` or `Ctrl+Shift+I`)
3. **Go to Console tab**
4. **Paste this command:**

```javascript
window.electronAPI.ipcRenderer.invoke('orders:clear-all').then(result => {
  console.log('Clear orders result:', result);
  if (result.success) {
    console.log(`✅ Successfully deleted ${result.deletedOrders} orders`);
    console.log(`✅ Successfully deleted ${result.deletedSyncQueue} sync queue items`);
  } else {
    console.error('❌ Failed to clear orders:', result.error);
  }
});
```

5. **Press Enter**
6. **Wait for confirmation** - You should see:
   - `✅ Successfully deleted X orders`
   - The dashboard will automatically refresh and show no orders
   - A toast notification: "All orders cleared successfully"

### What This Does:

- Deletes all orders from local SQLite database
- Clears sync queue
- Clears retry queue
- Clears conflicts
- Refreshes the UI automatically

### Note:

Orders in Supabase have already been deleted. This only clears the local POS database.

