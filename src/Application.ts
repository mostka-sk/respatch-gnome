import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { gjsFetch } from './libs/fetch.js';
import { SettingsService } from './services/SettingsService.js';
import { ProjectStore } from './stores/ProjectStore.js';
import { ApiClient } from './services/ApiClient.js';
import { LoggerService, ConsoleTransport, FileTransport, LogTransport } from './services/LoggerService.js';
import { WindowManager } from './WindowManager.js';
import { NotificationService } from './services/NotificationService.js';

export const Application = GObject.registerClass({
    GTypeName: 'RespatchApplication',
}, class Application extends Adw.Application {
    private uiDir!: string;
    private settingsService!: SettingsService;
    private projectStore!: ProjectStore;
    private apiClient!: ApiClient;
    private logger!: LoggerService;
    private windowManager!: WindowManager;
    private notificationService!: NotificationService;

    constructor() {
        super({
            application_id: 'sk.mostka.Respatch',
            flags: Gio.ApplicationFlags.FLAGS_NONE,
        });
    }

    vfunc_startup() {
        super.vfunc_startup();

        const file = Gio.File.new_for_uri(import.meta.url);
        this.uiDir = file.get_parent()?.get_path() || '';

        this.settingsService = new SettingsService();
        
        // Setup Logging
        const transports: LogTransport[] = [new ConsoleTransport()];
        
        const loggingEnabled = this.settingsService.getLoggingEnabled();
        const logToFile = this.settingsService.getLogToFile();

        if (logToFile) {
            let logPath = this.settingsService.getLogPath();
            if (!logPath) {
                const logDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'respatch']);
                logPath = GLib.build_filenamev([logDir, 'respatch.log']);
            } else if (logPath.startsWith('~/')) {
                logPath = GLib.build_filenamev([GLib.get_home_dir(), logPath.slice(2)]);
            }
            transports.push(new FileTransport(logPath));
        }

        this.logger = new LoggerService(transports, loggingEnabled);
        this.logger.info('Application started');

        this._loadStyle();

        this.apiClient = new ApiClient(gjsFetch);
        this.projectStore = new ProjectStore(this.settingsService);
        this.notificationService = new NotificationService(this);
        this.windowManager = new WindowManager(
            this,
            this.uiDir,
            this.projectStore,
            this.apiClient,
            this.settingsService,
            this.logger,
            this.notificationService
        );

        // Register notification mute actions
        const mute1hAction = new Gio.SimpleAction({ name: 'mute-1h' });
        mute1hAction.connect('activate', () => {
            this.logger.info('Muting notifications for 1 hour');
            this.notificationService.mute(3600);
        });
        this.add_action(mute1hAction);

        const mute1dAction = new Gio.SimpleAction({ name: 'mute-1d' });
        mute1dAction.connect('activate', () => {
            this.logger.info('Muting notifications for 1 day');
            this.notificationService.mute(86400);
        });
        this.add_action(mute1dAction);

        const muteOffAction = new Gio.SimpleAction({ name: 'mute-off' });
        muteOffAction.connect('activate', () => {
            this.logger.info('Turning off notifications');
            this.notificationService.mute(-1);
        });
        this.add_action(muteOffAction);

        // Action triggered when notification is clicked
        const openMainAction = new Gio.SimpleAction({ name: 'open-main' });
        openMainAction.connect('activate', () => {
            this.logger.info('Opening main application from notification');
            this.activate();
        });
        this.add_action(openMainAction);
    }

    vfunc_activate() {
        super.vfunc_activate();
        this.logger.info('Application activated');

        const activeWindow = this.get_active_window();
        if (activeWindow) {
            activeWindow.present();
            return;
        }

        if (this.projectStore.hasActiveProject()) {
            this.windowManager.showMain();
        } else {
            this.windowManager.showWelcome();
        }
    }

    private _loadStyle() {
        const provider = new Gtk.CssProvider();
        const stylePath = GLib.build_filenamev([this.uiDir, 'ui', 'style.css']);
        const styleFile = Gio.File.new_for_path(stylePath);
        
        try {
            provider.load_from_file(styleFile);
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default()!,
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
            this.logger.info(`CSS loaded from ${stylePath}`);
        } catch (e) {
            this.logger.error(`Failed to load CSS from ${stylePath}: ${e}`);
        }
    }
});

export type Application = InstanceType<typeof Application>;
