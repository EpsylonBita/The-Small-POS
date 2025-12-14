import { BrowserWindow } from 'electron';
import { SettingsService } from '../SettingsService';

export class ConfigurationSyncService {
    private mainWindow: BrowserWindow | null = null;
    private pendingSettingsUpdates: Map<string, Array<{ key: string; value: any }>> = new Map();
    private settingsBatchTimeout: NodeJS.Timeout | null = null;

    constructor(private settingsService: SettingsService) { }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public async handleStaffPermissionsSync(payload: any): Promise<void> {
        try {
            console.log('🔄 Staff permissions sync received:', payload);

            const { eventType, new: newRecord } = payload;

            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                const { staff_id, permission_key, permission_value } = newRecord;

                // Update local staff permissions
                await this.updateLocalStaffPermission(staff_id, permission_key, permission_value);

                // Notify renderer
                this.notifyRenderer('staff:permission-update', {
                    staff_id,
                    permission_key,
                    permission_value,
                    timestamp: new Date().toISOString()
                });

                console.log(`✅ Staff permission updated: ${permission_key} = ${permission_value} for staff ${staff_id}`);
            }
        } catch (error) {
            console.error('❌ Failed to handle staff permissions sync:', error);
        }
    }

    public async handleHardwareConfigSync(payload: any): Promise<void> {
        try {
            console.log('🔧 Hardware configuration sync received:', payload);

            const { eventType, new: newRecord } = payload;

            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                const { hardware_type, hardware_config, requires_restart } = newRecord;

                // Update local hardware configuration
                await this.updateLocalHardwareConfig(hardware_type, hardware_config);

                // Notify renderer
                this.notifyRenderer('hardware-config:update', {
                    hardware_type,
                    hardware_config,
                    requires_restart,
                    timestamp: new Date().toISOString()
                });

                // If restart is required, notify user
                if (requires_restart) {
                    this.notifyRenderer('app:restart-required', {
                        reason: `Hardware configuration updated: ${hardware_type}`,
                        hardware_type
                    });
                }

                console.log(`✅ Hardware configuration updated: ${hardware_type}`);
            }
        } catch (error) {
            console.error('❌ Failed to handle hardware configuration sync:', error);
        }
    }

    public async handleRestaurantSettingsSync(data: any): Promise<void> {
        // Update local restaurant settings
        this.notifyRenderer('settings:update', { category: 'restaurant', ...data });
        this.notifyRenderer('settings:update:restaurant', data);
    }

    public async handlePOSConfigurationSync(payload: any): Promise<void> {
        try {
            console.log('⚙️  POS configuration sync received:', payload);

            const { eventType, new: newRecord, old: oldRecord } = payload;

            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                const { setting_category, setting_key, setting_value, settings_version } = newRecord;

                if (!this.settingsService) {
                    console.warn('SettingsService not available, skipping version-aware apply');
                    return;
                }

                // Compare version
                const localVersion = this.settingsService.getSettingsVersion(setting_category as any);

                if (settings_version <= localVersion) {
                    console.log(`Skipping setting ${setting_category}.${setting_key}: version ${settings_version} <= local ${localVersion}`);
                    return;
                }

                // Parse value
                let parsedValue;
                try {
                    parsedValue = typeof setting_value === 'string' ? JSON.parse(setting_value) : setting_value;
                } catch (e) {
                    parsedValue = setting_value;
                }

                // Stage update for batching by category@version
                const batchKey = `${setting_category}@${settings_version}`;
                if (!this.pendingSettingsUpdates.has(batchKey)) {
                    this.pendingSettingsUpdates.set(batchKey, []);
                }
                this.pendingSettingsUpdates.get(batchKey)!.push({ key: setting_key, value: parsedValue });

                // Debounce batch flush (100ms)
                if (this.settingsBatchTimeout) {
                    clearTimeout(this.settingsBatchTimeout);
                }
                this.settingsBatchTimeout = setTimeout(() => this.flushPendingSettings(), 100);

            } else if (eventType === 'DELETE') {
                console.log(`⚠️  POS configuration deleted: ${oldRecord.setting_category}.${oldRecord.setting_key}`);

                if (this.settingsService) {
                    this.settingsService.deleteSetting(oldRecord.setting_category as any, oldRecord.setting_key);
                }

                if (this.mainWindow) {
                    this.mainWindow.webContents.send(`settings:delete:${oldRecord.setting_category}`, {
                        category: oldRecord.setting_category,
                        key: oldRecord.setting_key,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            console.error('❌ Failed to handle POS configuration sync:', error);
        }
    }

    private async flushPendingSettings(): Promise<void> {
        if (!this.settingsService || this.pendingSettingsUpdates.size === 0) {
            return;
        }

        try {
            for (const [batchKey, updates] of this.pendingSettingsUpdates) {
                const [category, versionStr] = batchKey.split('@');
                const version = parseInt(versionStr, 10);

                // Bulk apply settings
                const settingsArray = updates.map(u => ({ category: category as any, key: u.key, value: u.value }));

                try {
                    this.settingsService.bulkUpdateSettingsWithVersion(settingsArray, version);

                    const keysUpdated = updates.map(u => u.key);
                    console.log(`✅ Applied ${keysUpdated.length} settings for ${category} (v${version})`);

                    // Emit events
                    const eventData = {
                        category,
                        keys_updated: keysUpdated,
                        version,
                        timestamp: new Date().toISOString()
                    };

                    if (this.mainWindow) {
                        this.mainWindow.webContents.send('settings:update', eventData);
                        this.mainWindow.webContents.send(`settings:update:${category}`, eventData);
                    }
                } catch (error) {
                    console.error(`Failed to apply settings batch for ${category}@${version}:`, error);
                }
            }

            this.pendingSettingsUpdates.clear();
        } catch (error) {
            console.error('Error flushing pending settings:', error);
        }
    }

    private async updateLocalStaffPermission(staffId: string, permissionKey: string, permissionValue: boolean): Promise<void> {
        // Update local database with staff permission
        // This would integrate with your local staff management system
        console.log(`Updating local staff permission: ${staffId} - ${permissionKey} = ${permissionValue}`);
    }

    private async updateLocalHardwareConfig(hardwareType: string, config: any): Promise<void> {
        // Update local hardware configuration
        // This would integrate with your hardware management system
        console.log(`Updating local hardware config: ${hardwareType}`, config);
    }

    private notifyRenderer(channel: string, data: any) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}
