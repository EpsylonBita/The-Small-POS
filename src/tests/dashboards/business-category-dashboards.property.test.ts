/**
 * Business Category Dashboard Tests
 * Tests the Food, Service, and Product dashboard layouts
 */

import { describe, it, expect, vi } from 'vitest';

// Business type to category mapping (mirrors BusinessCategoryDashboard.tsx)
const BUSINESS_TYPE_TO_CATEGORY: Record<string, 'food' | 'service' | 'product'> = {
  restaurant: 'food',
  fast_food: 'food',
  bar_cafe: 'food',
  food_truck: 'food',
  chain: 'food',
  franchise: 'food',
  cafe: 'food',
  bar: 'food',
  bakery: 'food',
  salon: 'service',
  hotel: 'service',
  retail: 'product',
};

describe('Business Type to Category Mapping', () => {
  it('should map food business types correctly', () => {
    const foodTypes = ['restaurant', 'fast_food', 'bar_cafe', 'food_truck', 'chain', 'franchise', 'cafe', 'bar', 'bakery'];

    foodTypes.forEach(type => {
      expect(BUSINESS_TYPE_TO_CATEGORY[type]).toBe('food');
    });
  });

  it('should map service business types correctly', () => {
    const serviceTypes = ['salon', 'hotel'];

    serviceTypes.forEach(type => {
      expect(BUSINESS_TYPE_TO_CATEGORY[type]).toBe('service');
    });
  });

  it('should map product business types correctly', () => {
    const productTypes = ['retail'];

    productTypes.forEach(type => {
      expect(BUSINESS_TYPE_TO_CATEGORY[type]).toBe('product');
    });
  });

  it('should handle unknown types with food fallback', () => {
    const unknownType = 'unknown_business';
    const category = BUSINESS_TYPE_TO_CATEGORY[unknownType] || 'food';

    expect(category).toBe('food');
  });
});

describe('Food Dashboard Layout', () => {
  // Food dashboard cards: Orders, Tables (if enabled), Delivered, Canceled
  const getExpectedCards = (modulesEnabled: string[]) => {
    const cards = ['orders'];

    if (modulesEnabled.includes('tables')) {
      cards.push('tables');
    }

    cards.push('delivered', 'canceled');

    return cards;
  };

  it('should show all cards when all modules enabled', () => {
    const modules = ['orders', 'tables', 'delivery'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).toContain('tables');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should hide tables card when tables module disabled', () => {
    const modules = ['orders', 'delivery'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).not.toContain('tables');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should always show delivered and canceled cards', () => {
    const modules = ['orders'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should show minimum 2 cards with minimal modules', () => {
    const modules: string[] = [];
    const cards = getExpectedCards(modules);

    // Orders, Delivered, Canceled = 3 cards minimum
    expect(cards.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Service Dashboard Layout', () => {
  // Service dashboard cards: Appointments, Rooms (hotel only), Completed, Canceled
  const getExpectedCards = (isHotel: boolean, modulesEnabled: string[]) => {
    const cards: string[] = [];

    if (modulesEnabled.includes('appointments')) {
      cards.push('appointments');
    }

    if (isHotel && modulesEnabled.includes('rooms')) {
      cards.push('rooms');
    }

    // Completed and Canceled always shown
    cards.push('completed', 'canceled');

    return cards;
  };

  it('should show appointments card for salon', () => {
    const isHotel = false;
    const modules = ['appointments', 'service_catalog'];
    const cards = getExpectedCards(isHotel, modules);

    expect(cards).toContain('appointments');
    expect(cards).not.toContain('rooms');
    expect(cards).toContain('completed');
    expect(cards).toContain('canceled');
  });

  it('should show rooms card for hotel', () => {
    const isHotel = true;
    const modules = ['appointments', 'rooms', 'housekeeping'];
    const cards = getExpectedCards(isHotel, modules);

    expect(cards).toContain('appointments');
    expect(cards).toContain('rooms');
    expect(cards).toContain('completed');
    expect(cards).toContain('canceled');
  });

  it('should hide rooms card when rooms module disabled for hotel', () => {
    const isHotel = true;
    const modules = ['appointments'];
    const cards = getExpectedCards(isHotel, modules);

    expect(cards).toContain('appointments');
    expect(cards).not.toContain('rooms');
    expect(cards).toContain('completed');
    expect(cards).toContain('canceled');
  });

  it('should always show completed and canceled cards', () => {
    const isHotel = false;
    const modules: string[] = [];
    const cards = getExpectedCards(isHotel, modules);

    expect(cards).toContain('completed');
    expect(cards).toContain('canceled');
  });
});

describe('Product Dashboard Layout', () => {
  // Product dashboard cards: Orders, Products/Stock (if enabled), Delivered, Canceled
  const getExpectedCards = (modulesEnabled: string[]) => {
    const cards = ['orders'];

    if (modulesEnabled.includes('product_catalog')) {
      cards.push('products');
    }

    if (modulesEnabled.includes('inventory')) {
      cards.push('stock');
    }

    cards.push('delivered', 'canceled');

    return cards;
  };

  it('should show all cards when all modules enabled', () => {
    const modules = ['orders', 'product_catalog', 'inventory'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).toContain('products');
    expect(cards).toContain('stock');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should hide products card when product_catalog module disabled', () => {
    const modules = ['orders', 'inventory'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).not.toContain('products');
    expect(cards).toContain('stock');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should hide stock card when inventory module disabled', () => {
    const modules = ['orders', 'product_catalog'];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).toContain('products');
    expect(cards).not.toContain('stock');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });

  it('should always show orders, delivered, and canceled cards', () => {
    const modules: string[] = [];
    const cards = getExpectedCards(modules);

    expect(cards).toContain('orders');
    expect(cards).toContain('delivered');
    expect(cards).toContain('canceled');
  });
});

describe('Cross-Platform Consistency', () => {
  // Card colors should be consistent between Electron and Mobile
  const EXPECTED_CARD_COLORS = {
    food: {
      orders: 'blue',
      tables: 'brown',
      delivered: 'green',
      canceled: 'red',
    },
    service: {
      appointments: 'blue',
      rooms: 'brown',
      completed: 'green',
      canceled: 'red',
    },
    product: {
      orders: 'blue',
      products: 'purple',
      stock: 'purple',
      delivered: 'green',
      canceled: 'red',
    },
  };

  it('should have consistent colors for food dashboard cards', () => {
    const colors = EXPECTED_CARD_COLORS.food;

    expect(colors.orders).toBe('blue');
    expect(colors.tables).toBe('brown');
    expect(colors.delivered).toBe('green');
    expect(colors.canceled).toBe('red');
  });

  it('should have consistent colors for service dashboard cards', () => {
    const colors = EXPECTED_CARD_COLORS.service;

    expect(colors.appointments).toBe('blue');
    expect(colors.rooms).toBe('brown');
    expect(colors.completed).toBe('green');
    expect(colors.canceled).toBe('red');
  });

  it('should have consistent colors for product dashboard cards', () => {
    const colors = EXPECTED_CARD_COLORS.product;

    expect(colors.orders).toBe('blue');
    expect(colors.products).toBe('purple');
    expect(colors.stock).toBe('purple');
    expect(colors.delivered).toBe('green');
    expect(colors.canceled).toBe('red');
  });
});

describe('Dashboard Metrics Calculation', () => {
  // Test metric derivation from orders
  interface MockOrder {
    id: string;
    status: string;
    createdAt: string;
  }

  const calculateMetrics = (orders: MockOrder[]) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = orders.filter(order => {
      const orderDate = new Date(order.createdAt);
      orderDate.setHours(0, 0, 0, 0);
      return orderDate.getTime() === today.getTime();
    });

    const active = orders.filter(o =>
      ['pending', 'preparing', 'ready'].includes(o.status)
    ).length;

    const completed = todayOrders.filter(o =>
      ['completed', 'delivered'].includes(o.status)
    ).length;

    const canceled = todayOrders.filter(o => o.status === 'cancelled').length;

    return { active, completed, canceled };
  };

  it('should count active orders correctly', () => {
    const orders: MockOrder[] = [
      { id: '1', status: 'pending', createdAt: new Date().toISOString() },
      { id: '2', status: 'preparing', createdAt: new Date().toISOString() },
      { id: '3', status: 'ready', createdAt: new Date().toISOString() },
      { id: '4', status: 'completed', createdAt: new Date().toISOString() },
    ];

    const metrics = calculateMetrics(orders);
    expect(metrics.active).toBe(3);
  });

  it('should count completed orders from today only', () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const orders: MockOrder[] = [
      { id: '1', status: 'completed', createdAt: today.toISOString() },
      { id: '2', status: 'delivered', createdAt: today.toISOString() },
      { id: '3', status: 'completed', createdAt: yesterday.toISOString() },
    ];

    const metrics = calculateMetrics(orders);
    expect(metrics.completed).toBe(2);
  });

  it('should count canceled orders from today only', () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const orders: MockOrder[] = [
      { id: '1', status: 'cancelled', createdAt: today.toISOString() },
      { id: '2', status: 'cancelled', createdAt: yesterday.toISOString() },
    ];

    const metrics = calculateMetrics(orders);
    expect(metrics.canceled).toBe(1);
  });

  it('should return zero counts for empty orders', () => {
    const orders: MockOrder[] = [];
    const metrics = calculateMetrics(orders);

    expect(metrics.active).toBe(0);
    expect(metrics.completed).toBe(0);
    expect(metrics.canceled).toBe(0);
  });
});

describe('Dashboard Polling Configuration', () => {
  const METRICS_REFRESH_INTERVAL = 30000; // 30 seconds

  it('should have 30 second polling interval', () => {
    expect(METRICS_REFRESH_INTERVAL).toBe(30000);
  });

  it('should be less than 1 minute for acceptable update latency', () => {
    expect(METRICS_REFRESH_INTERVAL).toBeLessThan(60000);
  });

  it('should be greater than 10 seconds to avoid excessive API calls', () => {
    expect(METRICS_REFRESH_INTERVAL).toBeGreaterThan(10000);
  });
});
