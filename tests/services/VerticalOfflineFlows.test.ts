import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetBridge,
  resetPlatformCache,
  setBridge,
} from '../../src/lib';
import { reservationsService } from '../../src/renderer/services/ReservationsService';
import { driveThruService } from '../../src/renderer/services/DriveThruService';
import { appointmentsService } from '../../src/renderer/services/AppointmentsService';

function installTauriRuntime() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: {
      __TAURI__: {},
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });
  resetPlatformCache();

  return () => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
    resetBridge();
    resetPlatformCache();
  };
}

function reservationApiRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reservation-1',
    organization_id: 'org-1',
    branch_id: 'branch-1',
    reservation_number: 'RSV-001',
    customer_id: null,
    customer_name: 'Ada Lovelace',
    customer_phone: '123456',
    customer_email: 'ada@example.com',
    party_size: 4,
    table_id: 'table-7',
    table_number: 7,
    room_id: null,
    room_number: null,
    check_in_date: null,
    check_out_date: null,
    reservation_date: '2026-04-11',
    reservation_time: '18:00',
    reservation_datetime: '2026-04-11T18:00:00.000Z',
    duration_minutes: 90,
    status: 'confirmed',
    special_requests: null,
    notes: 'Window seat',
    confirmed_at: '2026-04-10T10:00:00.000Z',
    seated_at: null,
    completed_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    created_at: '2026-04-10T09:00:00.000Z',
    updated_at: '2026-04-10T09:30:00.000Z',
    ...overrides,
  };
}

function appointmentApiRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appointment-1',
    organization_id: 'org-1',
    branch_id: 'branch-1',
    customer_id: 'customer-1',
    customer_name: 'Ada Lovelace',
    customer_phone: '123456',
    customer_email: 'ada@example.com',
    staff_id: 'staff-1',
    staff_name: 'Taylor Stylist',
    service_id: 'service-1',
    service_name: 'Haircut',
    start_time: '2026-04-11T10:00:00.000Z',
    end_time: '2026-04-11T10:30:00.000Z',
    status: 'scheduled',
    notes: 'First visit',
    created_at: '2026-04-10T09:00:00.000Z',
    updated_at: '2026-04-10T09:30:00.000Z',
    is_multi_service: false,
    total_duration_minutes: 30,
    total_price: 25,
    confirmed_at: null,
    checked_in_at: null,
    completed_at: null,
    appointment_services: [],
    appointment_resources: [],
    ...overrides,
  };
}

function driveThruOrderApiRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dto-1',
    organization_id: 'org-1',
    branch_id: 'branch-1',
    lane_id: 'lane-1',
    order_id: 'order-1',
    order_number: 'DT-001',
    customer_name: 'Drive Guest',
    position: 2,
    status: 'preparing',
    arrived_at: '2026-04-11T10:00:00.000Z',
    served_at: null,
    wait_time_seconds: 120,
    created_at: '2026-04-11T10:00:00.000Z',
    updated_at: '2026-04-11T10:02:00.000Z',
    ...overrides,
  };
}

test('ReservationsService desktop create/update use bridge reservation transport and preserve transformed output', async () => {
  const cleanup = installTauriRuntime();
  const calls: {
    create: Array<Record<string, unknown>>;
    update: Array<{ reservationId: string; payload: Record<string, unknown> }>;
  } = { create: [], update: [] };

  const bridge = {
    reservations: {
      create: async (payload: Record<string, unknown>) => {
        calls.create.push(payload);
        return {
          success: true,
          data: {
            success: true,
            reservation: reservationApiRecord(),
          },
        };
      },
      update: async (reservationId: string, payload: Record<string, unknown>) => {
        calls.update.push({ reservationId, payload });
        return {
          success: true,
          data: {
            success: true,
            reservation: reservationApiRecord({
              id: reservationId,
              status: payload.status || 'confirmed',
              cancellation_reason: payload.cancellation_reason || null,
            }),
          },
        };
      },
    },
  } as any;

  setBridge(bridge);
  (reservationsService as any).bridge = bridge;

  try {
    const created = await reservationsService.createReservation({
      customerName: 'Ada Lovelace',
      customerPhone: '123456',
      customerEmail: 'ada@example.com',
      partySize: 4,
      reservationDate: '2026-04-11',
      reservationTime: '18:00',
      durationMinutes: 120,
      tableId: 'table-7',
      notes: 'Window seat',
    });

    assert.deepEqual(calls.create, [
      {
        customerName: 'Ada Lovelace',
        customerPhone: '123456',
        customerEmail: 'ada@example.com',
        partySize: 4,
        reservationDate: '2026-04-11',
        reservationTime: '18:00',
        durationMinutes: 120,
        tableId: 'table-7',
        roomId: undefined,
        roomNumber: undefined,
        checkInDate: undefined,
        checkOutDate: undefined,
        customerId: undefined,
        specialRequests: undefined,
        notes: 'Window seat',
      },
    ]);
    assert.equal(created.id, 'reservation-1');
    assert.equal(created.customerName, 'Ada Lovelace');
    assert.equal(created.status, 'confirmed');

    const updated = await reservationsService.updateStatus('reservation-42', 'cancelled', {
      cancellationReason: 'Customer request',
    });

    assert.deepEqual(calls.update, [
      {
        reservationId: 'reservation-42',
        payload: {
          status: 'cancelled',
          cancellation_reason: 'Customer request',
        },
      },
    ]);
    assert.equal(updated.id, 'reservation-42');
    assert.equal(updated.status, 'cancelled');
    assert.equal(updated.cancellationReason, 'Customer request');
  } finally {
    cleanup();
  }
});

test('DriveThruService desktop reads use cached admin fetch and status updates use offline mutation bridge', async () => {
  const cleanup = installTauriRuntime();
  const calls: {
    adminFetch: Array<{ path: string; options?: Record<string, unknown> }>;
    invoke: Array<{ channel: string; payload: Record<string, unknown> }>;
  } = { adminFetch: [], invoke: [] };

  const bridge = {
    adminApi: {
      fetchFromAdmin: async (path: string, options?: Record<string, unknown>) => {
        calls.adminFetch.push({ path, options });
        return {
          success: true,
          data: {
            success: true,
            orders: [driveThruOrderApiRecord()],
          },
        };
      },
    },
    invoke: async (channel: string, payload: Record<string, unknown>) => {
      calls.invoke.push({ channel, payload });
      if (channel === 'offline:drive-thru-update-status') {
        return {
          success: true,
          data: {
            order: driveThruOrderApiRecord({
              id: payload.drive_through_order_id,
              status: payload.status,
            }),
          },
        };
      }
      throw new Error(`Unexpected channel ${channel}`);
    },
  } as any;

  setBridge(bridge);
  (driveThruService as any).bridge = bridge;
  driveThruService.setContext('branch-1', 'org-1');

  try {
    const orders = await driveThruService.fetchOrders('lane-1');

    assert.deepEqual(calls.adminFetch, [
      {
        path: '/api/pos/drive-through?lane_id=lane-1',
        options: { method: 'GET' },
      },
    ]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0]?.id, 'dto-1');
    assert.equal(orders[0]?.orderNumber, 'DT-001');

    const updated = await driveThruService.updateOrderStatus('dto-9', 'ready');

    assert.deepEqual(calls.invoke, [
      {
        channel: 'offline:drive-thru-update-status',
        payload: {
          drive_through_order_id: 'dto-9',
          status: 'ready',
        },
      },
    ]);
    assert.equal(updated.id, 'dto-9');
    assert.equal(updated.status, 'ready');
  } finally {
    cleanup();
  }
});

test('AppointmentsService desktop create/status updates use offline mutation channels and preserve transformed output', async () => {
  const cleanup = installTauriRuntime();
  const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];

  const bridge = {
    invoke: async (channel: string, payload: Record<string, unknown>) => {
      calls.push({ channel, payload });
      if (channel === 'offline:appointment-create') {
        return {
          success: true,
          data: {
            appointment: appointmentApiRecord(),
          },
        };
      }
      if (channel === 'offline:appointment-update-status') {
        return {
          success: true,
          data: {
            appointment: appointmentApiRecord({
              id: payload.appointmentId,
              status: payload.status,
              completed_at: payload.status === 'completed' ? '2026-04-11T10:30:00.000Z' : null,
            }),
          },
        };
      }
      throw new Error(`Unexpected channel ${channel}`);
    },
  } as any;

  setBridge(bridge);
  (appointmentsService as any).bridge = bridge;

  try {
    const created = await appointmentsService.createAppointment({
      customerName: 'Ada Lovelace',
      customerPhone: '123456',
      customerEmail: 'ada@example.com',
      staffId: 'staff-1',
      serviceId: 'service-1',
      startTime: '2026-04-11T10:00:00.000Z',
      endTime: '2026-04-11T10:30:00.000Z',
      notes: 'First visit',
    });

    assert.deepEqual(calls[0], {
      channel: 'offline:appointment-create',
      payload: {
        customer_id: null,
        customer_name: 'Ada Lovelace',
        customer_phone: '123456',
        customer_email: 'ada@example.com',
        notes: 'First visit',
        staff_id: 'staff-1',
        service_id: 'service-1',
        start_time: '2026-04-11T10:00:00.000Z',
        end_time: '2026-04-11T10:30:00.000Z',
      },
    });
    assert.equal(created.id, 'appointment-1');
    assert.equal(created.customerName, 'Ada Lovelace');
    assert.equal(created.serviceName, 'Haircut');

    const updated = await appointmentsService.updateStatus('appointment-7', 'completed');

    assert.deepEqual(calls[1], {
      channel: 'offline:appointment-update-status',
      payload: {
        appointmentId: 'appointment-7',
        status: 'completed',
      },
    });
    assert.equal(updated.id, 'appointment-7');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.completedAt, '2026-04-11T10:30:00.000Z');
  } finally {
    cleanup();
  }
});
