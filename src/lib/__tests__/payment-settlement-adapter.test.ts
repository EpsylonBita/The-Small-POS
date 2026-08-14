import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { TauriBridge } from "../ipc-adapter";

describe("payment settlement Tauri adapter", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("loads one native settlement snapshot for an order", async () => {
    const nativeSnapshot = {
      success: true,
      orderId: "order-1",
      orderTotal: 42.5,
      netPaid: 10,
      outstandingAmount: 32.5,
      completedPayments: [
        { id: "payment-1", status: "completed", method: "cash", amount: 10 },
      ],
      generation: "a".repeat(64),
    };
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot);
    const bridge = new TauriBridge();

    const result = await bridge.payments.getSettlementSnapshot("order-1");

    expect(mocks.invoke).toHaveBeenCalledWith(
      "payment_get_settlement_snapshot",
      { arg0: "order-1" },
    );
    expect(result).toEqual(nativeSnapshot);
  });

  it("forwards the authoritative-outstanding collection flag unchanged", async () => {
    const nativeResult = {
      success: true,
      orderId: "order-2",
      paymentId: "payment-2",
      method: "cash",
      amount: 42.5,
      settlement: {
        orderTotal: 42.5,
        netPaid: 42.5,
        outstandingAmount: 0,
        completedPayments: [
          { id: "payment-2", status: "completed", method: "cash", amount: 42.5 },
        ],
        generation: "b".repeat(64),
      },
    };
    mocks.invoke.mockResolvedValueOnce(nativeResult);
    const bridge = new TauriBridge();

    const result = await bridge.payments.recordPayment({
      orderId: "order-2",
      method: "cash",
      amount: 1,
      cashReceived: 50,
      collectOutstandingBalance: true,
      expectedSettlementGeneration: "a".repeat(64),
    });

    expect(mocks.invoke).toHaveBeenCalledWith("payment_record", {
      arg0: {
        orderId: "order-2",
        method: "cash",
        amount: 1,
        cashReceived: 50,
        collectOutstandingBalance: true,
        expectedSettlementGeneration: "a".repeat(64),
      },
    });
    expect(result).toEqual(nativeResult);
  });
});
