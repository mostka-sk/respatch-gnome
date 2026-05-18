import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from './gettext.js';
import { WelcomeWindow } from './ui/windows/WelcomeWindow.js';
import { MainWindow } from './ui/windows/MainWindow.js';
import { SettingsWindow } from './ui/windows/SettingsWindow.js';
import { ManageServersWindow } from './ui/windows/ManageServersWindow.js';
import { ProjectStore } from './stores/ProjectStore.js';
import { ApiClient } from './services/ApiClient.js';
import { LoggerService } from './services/LoggerService.js';
import { SettingsService } from './services/SettingsService.js';
import { NotificationService } from './services/NotificationService.js';

export class WindowManager {
    constructor(
        private app: Adw.Application,
        private uiDir: string,
        private store: ProjectStore,
        private apiClient: ApiClient,
        private settingsService: SettingsService,
        private logger: LoggerService,
        private notificationService: NotificationService
    ) {}

    showWelcome() {
        this.logger.debug('Showing Welcome window');
        const welcome = new WelcomeWindow(
            this.app,
            this.uiDir,
            this.apiClient,
            this.store,
            this.logger,
            () => this.showMain()
        );
        welcome.present();
    }

    showMain() {
        this.logger.debug('Showing Main window');
        const main = new MainWindow(
            this.app,
            this.uiDir,
            this,
            this.store,
            this.apiClient,
            this.logger,
            this.settingsService,
            this.notificationService
        );
        main.present();
    }

    showSettings(parent: Gtk.Window) {
        this.logger.debug('Opening Settings window');
        const settings = new SettingsWindow(
            this.uiDir,
            this.settingsService,
            this.logger
        );
        settings.window.set_transient_for(parent);
        settings.present();
    }

    showManageServers(parent: Gtk.Window) {
        this.logger.debug('Opening Manage Servers window');
        const manageServers = new ManageServersWindow(
            this.uiDir,
            this.store,
            this.apiClient,
            this.logger
        );
        manageServers.window.set_transient_for(parent);
        manageServers.present();
    }
    showAbout(parent: Gtk.Window) {
        this.logger.debug('Opening About window');
        const about = new Adw.AboutWindow({
            default_width: 450,
            default_height: 400,
            application_name: 'Respatch',
            developer_name: 'Jozef Môstka',
            website: 'https://github.com/respatch/respatch-gnome',
            issue_url: 'https://github.com/respatch/respatch-gnome/issues',
            comments: _('Programmed with love.\n\nThe entire application was coded via Junie under my detailed and expert supervision.\nI will be glad for new issues and feature requests on github.\nPlease leave a like on our repository!')
        });
        about.add_link('Jozef Môstka (GitHub)', 'https://github.com/tito10047/');
        about.set_transient_for(parent);
        about.present();
    }
}
