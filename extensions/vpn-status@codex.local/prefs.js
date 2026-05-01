import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VpnStatusPreferencesPage = GObject.registerClass(
class VpnStatusPreferencesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'VPN Status',
            icon_name: 'network-vpn-symbolic',
        });

        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        this.add(displayGroup);

        const showIndicator = new Adw.SwitchRow({
            title: 'Show top bar indicator',
            subtitle: 'Show or hide the VPN status item in the top bar.',
        });
        settings.bind('show-indicator', showIndicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(showIndicator);

        const showCountryFlag = new Adw.SwitchRow({
            title: 'Show proxy country flag',
            subtitle: 'Detects the outbound country only when a proxy is active.',
        });
        settings.bind('show-country-flag', showCountryFlag, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(showCountryFlag);

        const clashGroup = new Adw.PreferencesGroup({title: 'Clash API'});
        this.add(clashGroup);

        const apiUrl = new Adw.EntryRow({
            title: 'API URL',
        });
        settings.bind('clash-api-url', apiUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        clashGroup.add(apiUrl);

        const secret = new Adw.PasswordEntryRow({
            title: 'API secret',
        });
        settings.bind('clash-secret', secret, 'text', Gio.SettingsBindFlags.DEFAULT);
        clashGroup.add(secret);

        const geoGroup = new Adw.PreferencesGroup({title: 'Country Detection'});
        this.add(geoGroup);

        const geoUrl = new Adw.EntryRow({
            title: 'GeoIP URL',
        });
        settings.bind('geoip-url', geoUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        geoGroup.add(geoUrl);

        const note = new Gtk.Label({
            label: 'Country lookup is asynchronous and only runs when a proxy is active. Use manual refresh if the flag looks stale.',
            wrap: true,
            xalign: 0,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        geoGroup.add(note);
    }
});

export default class VpnStatusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new VpnStatusPreferencesPage(this.getSettings()));
    }
}
