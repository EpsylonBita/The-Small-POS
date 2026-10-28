import { getBridge } from '../../lib'
import type { MoneyApproval } from '../../lib/ipc-contracts'

export interface ManagerApprovalAvailability {
  available: boolean
  permission: string
}

/** Typed renderer bridge for the branch directory availability check. No PIN is sent. */
export async function managerApprovalAvailable(approval: MoneyApproval): Promise<ManagerApprovalAvailability> {
  return getBridge().invoke('auth_manager_approval_available', { approval })
}
