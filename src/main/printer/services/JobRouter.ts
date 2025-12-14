/**
 * Job Router Service
 *
 * Routes print jobs to appropriate printers based on job type and category.
 * Supports fallback printer logic and order splitting by item category.
 *
 * @module printer/services/JobRouter
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { v4 as uuidv4 } from 'uuid';
import {
  PrintJob,
  PrintJobType,
  PrinterRole,
  PrinterConfig,
  PrinterState,
  PrintOrderItem,
  KitchenTicketData,
  isKitchenTicketData,
} from '../types';

/**
 * Routing table entry mapping job type to printer ID
 */
export interface RoutingEntry {
  jobType: PrintJobType;
  printerId: string;
}

/**
 * Category routing entry mapping item category to printer ID
 */
export interface CategoryRoutingEntry {
  category: string;
  printerId: string;
}

/**
 * Fallback configuration mapping primary printer to fallback printer
 */
export interface FallbackEntry {
  primaryPrinterId: string;
  fallbackPrinterId: string;
}

/**
 * Result of routing a job
 */
export interface RoutingResult {
  printerId: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

/**
 * Result of splitting an order
 */
export interface SplitOrderResult {
  jobs: PrintJob[];
  unroutedItems: PrintOrderItem[];
}

/**
 * Interface for getting printer status (dependency injection)
 */
export interface PrinterStatusProvider {
  getPrinterStatus(printerId: string): { state: PrinterState } | null;
  getPrinterConfig(printerId: string): PrinterConfig | null;
  getPrintersByRole(role: PrinterRole): PrinterConfig[];
}

/**
 * JobRouter - Routes print jobs to appropriate printers
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */
export class JobRouter {
  private routingTable: Map<PrintJobType, string> = new Map();
  private categoryRouting: Map<string, string> = new Map();
  private fallbackTable: Map<string, string> = new Map();
  private statusProvider: PrinterStatusProvider | null = null;
  private defaultPrinterId: string | null = null;

  constructor(statusProvider?: PrinterStatusProvider) {
    this.statusProvider = statusProvider || null;
  }

  /**
   * Set the status provider for checking printer availability
   */
  setStatusProvider(provider: PrinterStatusProvider): void {
    this.statusProvider = provider;
  }

  /**
   * Set the default printer ID for jobs without specific routing
   */
  setDefaultPrinter(printerId: string): void {
    this.defaultPrinterId = printerId;
  }

  /**
   * Get the default printer ID
   */
  getDefaultPrinter(): string | null {
    return this.defaultPrinterId;
  }

  /**
   * Set routing for a specific job type to a printer
   * @param jobType - The type of print job
   * @param printerId - The target printer ID
   *
   * Requirements: 9.1, 9.2
   */
  setRouting(jobType: PrintJobType, printerId: string): void {
    this.routingTable.set(jobType, printerId);
  }

  /**
   * Remove routing for a specific job type
   * @param jobType - The type of print job
   */
  removeRouting(jobType: PrintJobType): void {
    this.routingTable.delete(jobType);
  }

  /**
   * Get the routing table
   * @returns Map of job types to printer IDs
   */
  getRouting(): Map<PrintJobType, string> {
    return new Map(this.routingTable);
  }

  /**
   * Get the printer ID for a specific job type
   * @param jobType - The type of print job
   * @returns The printer ID or null if not configured
   */
  getRoutingForType(jobType: PrintJobType): string | null {
    return this.routingTable.get(jobType) || null;
  }

  /**
   * Set category-based routing for kitchen items
   * @param category - The item category (e.g., 'drinks', 'food', 'desserts')
   * @param printerId - The target printer ID
   *
   * Requirements: 9.4
   */
  setCategoryRouting(category: string, printerId: string): void {
    this.categoryRouting.set(category.toLowerCase(), printerId);
  }

  /**
   * Remove category routing
   * @param category - The item category
   */
  removeCategoryRouting(category: string): void {
    this.categoryRouting.delete(category.toLowerCase());
  }

  /**
   * Get category routing table
   * @returns Map of categories to printer IDs
   */
  getCategoryRouting(): Map<string, string> {
    return new Map(this.categoryRouting);
  }

  /**
   * Get the printer ID for a specific category
   * @param category - The item category
   * @returns The printer ID or null if not configured
   */
  getRoutingForCategory(category: string): string | null {
    return this.categoryRouting.get(category.toLowerCase()) || null;
  }

  /**
   * Set fallback printer for a primary printer
   * @param primaryPrinterId - The primary printer ID
   * @param fallbackPrinterId - The fallback printer ID
   *
   * Requirements: 9.3
   */
  setFallback(primaryPrinterId: string, fallbackPrinterId: string): void {
    this.fallbackTable.set(primaryPrinterId, fallbackPrinterId);
  }

  /**
   * Remove fallback configuration
   * @param primaryPrinterId - The primary printer ID
   */
  removeFallback(primaryPrinterId: string): void {
    this.fallbackTable.delete(primaryPrinterId);
  }

  /**
   * Get fallback table
   * @returns Map of primary printer IDs to fallback printer IDs
   */
  getFallbackTable(): Map<string, string> {
    return new Map(this.fallbackTable);
  }

  /**
   * Get the fallback printer for a primary printer
   * @param primaryPrinterId - The primary printer ID
   * @returns The fallback printer ID or null if not configured
   */
  getFallbackForPrinter(primaryPrinterId: string): string | null {
    return this.fallbackTable.get(primaryPrinterId) || null;
  }

  /**
   * Check if a printer is available (online and not in error state)
   * @param printerId - The printer ID to check
   * @returns true if printer is available
   */
  private isPrinterAvailable(printerId: string): boolean {
    if (!this.statusProvider) {
      // If no status provider, assume printer is available
      return true;
    }

    const status = this.statusProvider.getPrinterStatus(printerId);
    if (!status) {
      return false;
    }

    return status.state === PrinterState.ONLINE || status.state === PrinterState.BUSY;
  }

  /**
   * Route a print job to the appropriate printer
   * @param job - The print job to route
   * @returns The routing result with printer ID and fallback info
   *
   * Requirements: 9.2, 9.3
   */
  routeJob(job: PrintJob): RoutingResult {
    // First, try to get the printer from the routing table based on job type
    let targetPrinterId = this.routingTable.get(job.type);

    // If no specific routing, use default printer
    if (!targetPrinterId) {
      targetPrinterId = this.defaultPrinterId || undefined;
    }

    // If still no printer, throw error
    if (!targetPrinterId) {
      throw new Error(`No printer configured for job type: ${job.type}`);
    }

    // Check if the target printer is available
    if (this.isPrinterAvailable(targetPrinterId)) {
      return {
        printerId: targetPrinterId,
        usedFallback: false,
      };
    }

    // Target printer is not available, try fallback
    const fallbackPrinterId = this.fallbackTable.get(targetPrinterId);

    if (fallbackPrinterId && this.isPrinterAvailable(fallbackPrinterId)) {
      return {
        printerId: fallbackPrinterId,
        usedFallback: true,
        fallbackReason: `Primary printer ${targetPrinterId} is offline`,
      };
    }

    // Fallback is also not available or not configured
    // Return the primary printer (job will be queued)
    return {
      printerId: targetPrinterId,
      usedFallback: false,
      fallbackReason: fallbackPrinterId
        ? `Both primary and fallback printers are offline`
        : undefined,
    };
  }

  /**
   * Split an order into multiple print jobs based on item categories
   * @param job - The original print job (must be a kitchen ticket)
   * @returns Split jobs and any unrouted items
   *
   * Requirements: 9.4, 9.5
   */
  splitOrderByCategory(job: PrintJob): SplitOrderResult {
    // Only kitchen tickets can be split by category
    if (!isKitchenTicketData(job.data)) {
      return {
        jobs: [job],
        unroutedItems: [],
      };
    }

    const kitchenData = job.data as KitchenTicketData;
    const itemsByCategory = new Map<string, PrintOrderItem[]>();
    const unroutedItems: PrintOrderItem[] = [];

    // Group items by category
    for (const item of kitchenData.items) {
      const category = item.category?.toLowerCase();

      if (category && this.categoryRouting.has(category)) {
        const items = itemsByCategory.get(category) || [];
        items.push(item);
        itemsByCategory.set(category, items);
      } else {
        // Item has no category or category has no routing
        unroutedItems.push(item);
      }
    }

    // If no category routing is configured, return original job
    if (itemsByCategory.size === 0) {
      return {
        jobs: [job],
        unroutedItems: [],
      };
    }

    // Create separate jobs for each category
    const splitJobs: PrintJob[] = [];

    for (const [category, items] of itemsByCategory) {
      const printerId = this.categoryRouting.get(category)!;

      const splitJob: PrintJob = {
        id: uuidv4(),
        type: job.type,
        data: {
          ...kitchenData,
          items,
          station: category, // Update station to reflect the category
        } as KitchenTicketData,
        priority: job.priority,
        createdAt: job.createdAt,
        metadata: {
          ...job.metadata,
          originalJobId: job.id,
          category,
          targetPrinterId: printerId,
        },
      };

      splitJobs.push(splitJob);
    }

    // If there are unrouted items, create a job for them using default routing
    if (unroutedItems.length > 0) {
      const defaultPrinterId = this.routingTable.get(job.type) || this.defaultPrinterId;

      if (defaultPrinterId) {
        // Create a copy of unroutedItems to avoid mutation issues
        const unroutedItemsCopy = [...unroutedItems];
        
        const unroutedJob: PrintJob = {
          id: uuidv4(),
          type: job.type,
          data: {
            ...kitchenData,
            items: unroutedItemsCopy,
            station: 'default',
          } as KitchenTicketData,
          priority: job.priority,
          createdAt: job.createdAt,
          metadata: {
            ...job.metadata,
            originalJobId: job.id,
            category: 'default',
            targetPrinterId: defaultPrinterId,
          },
        };

        splitJobs.push(unroutedJob);
        // Clear unrouted items since we created a job for them
        unroutedItems.length = 0;
      }
    }

    return {
      jobs: splitJobs,
      unroutedItems,
    };
  }

  /**
   * Route a job with automatic category splitting for kitchen tickets
   * @param job - The print job to route
   * @returns Array of routing results (one per split job)
   *
   * Requirements: 9.2, 9.4, 9.5
   */
  routeJobWithSplitting(job: PrintJob): Array<{ job: PrintJob; routing: RoutingResult }> {
    // Check if this is a kitchen ticket that should be split
    if (job.type === PrintJobType.KITCHEN_TICKET && this.categoryRouting.size > 0) {
      const splitResult = this.splitOrderByCategory(job);

      return splitResult.jobs.map((splitJob) => {
        // Use the target printer from metadata if available (from category routing)
        const targetPrinterId = splitJob.metadata?.targetPrinterId as string | undefined;

        if (targetPrinterId) {
          // Check availability and fallback
          if (this.isPrinterAvailable(targetPrinterId)) {
            return {
              job: splitJob,
              routing: {
                printerId: targetPrinterId,
                usedFallback: false,
              },
            };
          }

          // Try fallback
          const fallbackPrinterId = this.fallbackTable.get(targetPrinterId);
          if (fallbackPrinterId && this.isPrinterAvailable(fallbackPrinterId)) {
            return {
              job: splitJob,
              routing: {
                printerId: fallbackPrinterId,
                usedFallback: true,
                fallbackReason: `Primary printer ${targetPrinterId} is offline`,
              },
            };
          }

          // Return primary (will be queued)
          return {
            job: splitJob,
            routing: {
              printerId: targetPrinterId,
              usedFallback: false,
            },
          };
        }

        // No target printer in metadata, use standard routing
        return {
          job: splitJob,
          routing: this.routeJob(splitJob),
        };
      });
    }

    // Not a kitchen ticket or no category routing, use standard routing
    return [
      {
        job,
        routing: this.routeJob(job),
      },
    ];
  }

  /**
   * Clear all routing configurations
   */
  clearAll(): void {
    this.routingTable.clear();
    this.categoryRouting.clear();
    this.fallbackTable.clear();
    this.defaultPrinterId = null;
  }

  /**
   * Export routing configuration for persistence
   */
  exportConfig(): {
    routing: RoutingEntry[];
    categoryRouting: CategoryRoutingEntry[];
    fallbacks: FallbackEntry[];
    defaultPrinterId: string | null;
  } {
    const routing: RoutingEntry[] = [];
    for (const [jobType, printerId] of this.routingTable) {
      routing.push({ jobType, printerId });
    }

    const categoryRouting: CategoryRoutingEntry[] = [];
    for (const [category, printerId] of this.categoryRouting) {
      categoryRouting.push({ category, printerId });
    }

    const fallbacks: FallbackEntry[] = [];
    for (const [primaryPrinterId, fallbackPrinterId] of this.fallbackTable) {
      fallbacks.push({ primaryPrinterId, fallbackPrinterId });
    }

    return {
      routing,
      categoryRouting,
      fallbacks,
      defaultPrinterId: this.defaultPrinterId,
    };
  }

  /**
   * Import routing configuration
   */
  importConfig(config: {
    routing?: RoutingEntry[];
    categoryRouting?: CategoryRoutingEntry[];
    fallbacks?: FallbackEntry[];
    defaultPrinterId?: string | null;
  }): void {
    if (config.routing) {
      this.routingTable.clear();
      for (const entry of config.routing) {
        this.routingTable.set(entry.jobType, entry.printerId);
      }
    }

    if (config.categoryRouting) {
      this.categoryRouting.clear();
      for (const entry of config.categoryRouting) {
        this.categoryRouting.set(entry.category.toLowerCase(), entry.printerId);
      }
    }

    if (config.fallbacks) {
      this.fallbackTable.clear();
      for (const entry of config.fallbacks) {
        this.fallbackTable.set(entry.primaryPrinterId, entry.fallbackPrinterId);
      }
    }

    if (config.defaultPrinterId !== undefined) {
      this.defaultPrinterId = config.defaultPrinterId;
    }
  }
}
