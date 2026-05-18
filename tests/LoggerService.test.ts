import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Gio
vi.mock('gi://Gio', () => {
    const mockStream = {
        write_all: vi.fn(),
        close: vi.fn(),
    };
    const mockParent = {
        query_exists: vi.fn().mockReturnValue(true),
        make_directory_with_parents: vi.fn(),
    };
    const mockFile = {
        get_parent: vi.fn().mockReturnValue(mockParent),
        append_to: vi.fn().mockReturnValue(mockStream),
    };
    return {
        default: {
            File: {
                new_for_path: vi.fn().mockReturnValue(mockFile),
            },
            FileCreateFlags: {
                NONE: 0,
            },
        }
    };
});

// Mock GLib
vi.mock('gi://GLib', () => ({
    default: {}
}));

import { LoggerService, ConsoleTransport, FileTransport } from '../src/services/LoggerService.js';

describe('LoggerService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should log to console transport', () => {
        const consoleSpy = vi.spyOn(console, 'log');
        const transport = new ConsoleTransport();
        const logger = new LoggerService([transport]);
        
        logger.info('Test message');
        
        expect(consoleSpy).toHaveBeenCalled();
        const callArgs = consoleSpy.mock.calls[0][0];
        expect(callArgs).toContain('[INFO]');
        expect(callArgs).toContain('Test message');
    });

    it('should log with context', () => {
        const consoleSpy = vi.spyOn(console, 'log');
        const transport = new ConsoleTransport();
        const logger = new LoggerService([transport]);
        
        logger.debug('Debug msg', { key: 'value' });
        
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain('{"key":"value"}');
    });

    it('should respect enabled flag', () => {
        const consoleSpy = vi.spyOn(console, 'log');
        const transport = new ConsoleTransport();
        const logger = new LoggerService([transport], false);
        
        logger.info('Should not be logged');
        
        expect(consoleSpy).not.toHaveBeenCalled();
        
        logger.setEnabled(true);
        logger.info('Should be logged');
        expect(consoleSpy).toHaveBeenCalled();
    });

    it('should log to file transport', async () => {
        const transport = new FileTransport('/tmp/test.log');
        const logger = new LoggerService([transport]);
        
        logger.error('File error');
        
        const Gio = (await import('gi://Gio')).default;
        const mockFile = Gio.File.new_for_path('/tmp/test.log');
        expect(mockFile.append_to).toHaveBeenCalled();
        expect((mockFile.append_to as any)().write_all).toHaveBeenCalled();
    });

    it('should fallback to console if file transport fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error');
        const Gio = (await import('gi://Gio')).default;
        const mockFile = Gio.File.new_for_path('');
        (mockFile.append_to as any).mockImplementation(() => {
            throw new Error('Write failed');
        });

        const transport = new FileTransport('/tmp/fail.log');
        const logger = new LoggerService([transport]);
        
        logger.error('File error');
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write to log file'));
    });
});
