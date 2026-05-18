import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import { _ } from './gettext.js';
import { gjsFetch } from './libs/fetch.js';
import { SettingsService } from './services/SettingsService.js';
import { ApiClient } from './services/ApiClient.js';
import { LoggerService, ConsoleTransport, FileTransport, LogTransport } from './services/LoggerService.js';
import { NotificationService } from './services/NotificationService.js';
import { Project } from './models/Project.js';

// Configuration
const POLL_INTERVAL_SECONDS = 10;

export const Daemon = Gio.Application.new('sk.mostka.Respatch.Daemon', Gio.ApplicationFlags.FLAGS_NONE);

let settingsService: SettingsService;
let apiClient: ApiClient;
let logger: LoggerService;
let notificationService: NotificationService;
let loopId: number | null = null;
let projectsToMonitor: Project[] = [];

function setupServices() {
    settingsService = new SettingsService();
    
    // Setup Logging
    const transports: LogTransport[] = [new ConsoleTransport()];
    if (settingsService.getLogToFile()) {
        let logPath = settingsService.getLogPath();
        if (!logPath) {
            const logDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'respatch']);
            logPath = GLib.build_filenamev([logDir, 'daemon.log']);
        } else {
            if (logPath.startsWith('~/')) {
                logPath = GLib.build_filenamev([GLib.get_home_dir(), logPath.slice(2)]);
            }
            // If the user specified a custom log file for the app, we use it for daemon as well, 
            // but append '-daemon' to the file name to avoid overlapping logs, or just change the name.
            // A simpler approach is to replace the filename with daemon.log if it ends with .log
            const dir = GLib.path_get_dirname(logPath);
            let base = GLib.path_get_basename(logPath);
            if (base.endsWith('.log')) {
                base = base.slice(0, -4) + '-daemon.log';
            } else {
                base = base + '-daemon';
            }
            logPath = GLib.build_filenamev([dir, base]);
        }
        transports.push(new FileTransport(logPath));
    }

    logger = new LoggerService(transports, settingsService.getLoggingEnabled());
    logger.info('Daemon starting');

    apiClient = new ApiClient(gjsFetch);
    notificationService = new NotificationService(Daemon);

    // Register notification mute actions
    const mute1hAction = new Gio.SimpleAction({ name: 'mute-1h' });
    mute1hAction.connect('activate', () => {
        logger.info('Muting notifications for 1 hour');
        notificationService.mute(3600);
    });
    Daemon.add_action(mute1hAction);

    const mute1dAction = new Gio.SimpleAction({ name: 'mute-1d' });
    mute1dAction.connect('activate', () => {
        logger.info('Muting notifications for 1 day');
        notificationService.mute(86400);
    });
    Daemon.add_action(mute1dAction);

    const muteOffAction = new Gio.SimpleAction({ name: 'mute-off' });
    muteOffAction.connect('activate', () => {
        logger.info('Turning off notifications');
        notificationService.mute(-1);
    });
    Daemon.add_action(muteOffAction);

    const openMainAction = new Gio.SimpleAction({ name: 'open-main' });
    openMainAction.connect('activate', () => {
        logger.info('Opening main application from daemon notification');
        try {
            const appInfo = GioUnix.DesktopAppInfo.new('sk.mostka.Respatch.desktop');
            if (appInfo) {
                appInfo.launch([], null);
                logger.info('Launched via DesktopAppInfo');
            } else {
                logger.warn('Desktop file not found. Falling back to DBus activation.');
                const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
                connection.call_sync(
                    'sk.mostka.Respatch',
                    '/sk/mostka/Respatch',
                    'org.freedesktop.Application',
                    'Activate',
                    new GLib.Variant('(a{sv})', [{}]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
                logger.info('Launched via DBus Activate');
            }
        } catch (e) {
            logger.error(`Failed to open main app: ${e}`);
        }
    });
    Daemon.add_action(openMainAction);

    loadConfig();

    // Listen to changes in settings so we don't have to restart daemon
    settingsService.getSettings().connect('changed', (settings: Gio.Settings, key: string) => {
        if (key === 'projects') {
            logger.info('Settings changed, reloading config...');
            loadConfig();
        }
    });
}

function loadConfig() {
    projectsToMonitor = settingsService.getProjects();
    logger.info(`Loaded config for ${projectsToMonitor.length} project(s).`);
}

async function checkFailedMessages() {
    if (projectsToMonitor.length === 0) {
        return GLib.SOURCE_CONTINUE;
    }

    const allKeys: string[] = [];

    for (const project of projectsToMonitor) {
        try {
            const transports = await apiClient.fetchTransports(project.url, project.token);
            const failureTransportNames = Object.entries(transports)
                .filter(([, info]) => info.failure)
                .map(([name]) => name);

            if (failureTransportNames.length === 0) {
                continue;
            }

            const results = await Promise.allSettled(
                failureTransportNames.map(name =>
                    apiClient.fetchFailedMessages(project.url, project.token, name)
                )
            );

            for (const result of results) {
                if (result.status === 'fulfilled') {
                    for (const msg of result.value) {
                        allKeys.push(`${msg.transport}:${msg.id}:${project.id}`);
                    }
                }
            }
        } catch (e) {
            logger.error(`Error checking failed messages for project ${project.name}: ${e}`);
        }
    }

    logger.info(`Found ${allKeys.length} failed messages to process.`);
    notificationService.processFailedMessages(allKeys);

    return GLib.SOURCE_CONTINUE;
}

Daemon.connect('startup', () => {
    setupServices();
});

Daemon.connect('activate', () => {
    // Start polling loop
    if (!loopId) {
        loopId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                checkFailedMessages().catch(e => logger.error(`Unhandled error in checkFailedMessages: ${e}`));
                return GLib.SOURCE_CONTINUE;
            }
        );
        logger.info(`Started polling every ${POLL_INTERVAL_SECONDS} seconds`);
    }
    Daemon.hold(); // Keep daemon alive
});

Daemon.connect('shutdown', () => {
    if (loopId) {
        GLib.source_remove(loopId);
        loopId = null;
    }
    logger.info('Daemon shutting down');
});

Daemon.run([import.meta.url]);
