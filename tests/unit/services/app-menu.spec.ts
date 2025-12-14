/**
 * Unit tests for Application Menu
 * 
 * Tests menu template generation and Help menu items
 * _Requirements: 1.1_
 */

import { getMenuTemplate, defaultConfig, MenuConfig } from '../../../src/main/app-menu';

// Mock electron modules
jest.mock('electron', () => ({
  app: {
    name: 'The Small POS',
  },
  Menu: {
    buildFromTemplate: jest.fn(),
    setApplicationMenu: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

// Mock service registry
jest.mock('../../../src/main/service-registry', () => ({
  serviceRegistry: {
    mainWindow: null,
    autoUpdaterService: null,
  },
}));

describe('Application Menu', () => {
  describe('getMenuTemplate', () => {
    it('should include a Help menu in the template', () => {
      const template = getMenuTemplate();
      
      const helpMenu = template.find(
        (item) => item.role === 'help' || item.label === 'Help'
      );
      
      expect(helpMenu).toBeDefined();
      expect(helpMenu?.role).toBe('help');
    });

    it('should include all required Help menu items', () => {
      const template = getMenuTemplate();
      
      const helpMenu = template.find(
        (item) => item.role === 'help' || item.label === 'Help'
      );
      
      expect(helpMenu).toBeDefined();
      expect(helpMenu?.submenu).toBeDefined();
      
      const submenu = helpMenu?.submenu as Array<{ label?: string; type?: string }>;
      const labels = submenu
        .filter((item) => item.label)
        .map((item) => item.label);
      
      expect(labels).toContain('Learn More');
      expect(labels).toContain('Documentation');
      expect(labels).toContain('Community Discussions');
      expect(labels).toContain('Search Issues');
      expect(labels).toContain('Check for Updates...');
    });

    it('should include standard menus (File, Edit, View, Window)', () => {
      const template = getMenuTemplate();
      
      const menuLabels = template
        .filter((item) => item.label)
        .map((item) => item.label);
      
      expect(menuLabels).toContain('File');
      expect(menuLabels).toContain('Edit');
      expect(menuLabels).toContain('View');
      expect(menuLabels).toContain('Window');
    });

    it('should have a separator before Check for Updates', () => {
      const template = getMenuTemplate();
      
      const helpMenu = template.find(
        (item) => item.role === 'help' || item.label === 'Help'
      );
      
      const submenu = helpMenu?.submenu as Array<{ label?: string; type?: string }>;
      
      // Find the index of Check for Updates
      const checkForUpdatesIndex = submenu.findIndex(
        (item) => item.label === 'Check for Updates...'
      );
      
      // The item before it should be a separator
      expect(checkForUpdatesIndex).toBeGreaterThan(0);
      expect(submenu[checkForUpdatesIndex - 1].type).toBe('separator');
    });
  });

  describe('defaultConfig', () => {
    it('should have correct default URLs', () => {
      expect(defaultConfig.learnMoreUrl).toBe('https://www.electronjs.org/');
      expect(defaultConfig.documentationUrl).toContain('github.com');
      expect(defaultConfig.communityUrl).toContain('discussions');
      expect(defaultConfig.issuesUrl).toContain('issues');
    });
  });
});
