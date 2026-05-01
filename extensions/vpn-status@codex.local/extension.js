import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STATUS_INTERVAL_SECONDS = 5;
const COUNTRY_REFRESH_SECONDS = 600;
const GEOIP_TIMEOUT_SECONDS = 3;
const COUNTRY_CACHE_LIMIT = 100;
const COUNTRY_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-shell']);
const COUNTRY_CACHE_PATH = GLib.build_filenamev([COUNTRY_CACHE_DIR, 'vpn-status-country-cache.json']);

function readTextFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [, contents] = file.load_contents(null);
        return new TextDecoder().decode(contents);
    } catch {
        return '';
    }
}

function listInterfaces() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/net');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        let info;

        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());

        enumerator.close(null);
        return names;
    } catch {
        return [];
    }
}

function isUp(name) {
    return readTextFile(`/sys/class/net/${name}/operstate`).trim() === 'up';
}

function detectInterfaces() {
    const active = listInterfaces().filter(isUp);

    return {
        wireguard: active.filter(name => /^wg\d*$|^wg[-_.]/i.test(name)),
        openvpn: active.filter(name => /^(tun|tap)\d*$|^ovpn[-_.\d]|^openvpn[-_.\d]/i.test(name)),
        tun: active.filter(name => /tun|tap|clash|meta|mihomo|utun/i.test(name)),
    };
}

function detectDefaultRoutes() {
    const text = readTextFile('/proc/net/route');
    const routes = [];

    for (const line of text.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11 && parts[1] === '00000000')
            routes.push(parts[0]);
    }

    return routes;
}

function detectOpenVpnProcesses() {
    try {
        const dir = Gio.File.new_for_path('/proc');
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const processes = [];
        let info;

        while ((info = enumerator.next_file(null)) !== null) {
            const pid = info.get_name();
            if (!/^\d+$/.test(pid))
                continue;

            const cmdline = readTextFile(`/proc/${pid}/cmdline`);
            if (!cmdline)
                continue;

            const args = cmdline.split('\0').filter(Boolean);
            const executable = args[0] ?? '';
            if (!/(^|\/)openvpn$/.test(executable))
                continue;

            const configIndex = args.findIndex(arg => arg === '--config' || arg === 'config');
            const configPath = configIndex >= 0 ? args[configIndex + 1] : '';
            const label = configPath ? GLib.path_get_basename(configPath) : `pid ${pid}`;
            processes.push(label);
        }

        enumerator.close(null);
        return processes;
    } catch {
        return [];
    }
}

function hasListeningTcpPort(port) {
    const wanted = port.toString(16).toUpperCase().padStart(4, '0');

    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = readTextFile(path);

        for (const line of text.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4)
                continue;

            const localPort = (parts[1] ?? '').split(':')[1];
            const state = parts[3] ?? '';

            if (localPort === wanted && state === '0A')
                return true;
        }
    }

    return false;
}

function detectClashProxy() {
    const ports = [7890, 7891, 7892, 7893, 7897, 7899];
    const listening = ports.filter(hasListeningTcpPort);

    return {
        active: listening.length > 0,
        ports: listening,
    };
}

function variantDeepUnpack(variant) {
    if (!variant)
        return null;

    try {
        return variant.deepUnpack();
    } catch {
        try {
            return variant.unpack();
        } catch {
            return null;
        }
    }
}

function parseCountryCode(text) {
    const trimmed = text.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed))
        return trimmed.toUpperCase();

    try {
        const parsed = JSON.parse(trimmed);
        const code = parsed.country_code ?? parsed.countryCode ?? parsed.country ?? '';
        return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : '';
    } catch {
        return '';
    }
}

function parseGeoIp(text) {
    const trimmed = text.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed))
        return {ip: '', countryCode: trimmed.toUpperCase()};

    try {
        const parsed = JSON.parse(trimmed);
        const code = parsed.country_code ?? parsed.countryCode ?? parsed.country ?? '';
        const ip = parsed.ip ?? parsed.query ?? '';
        return {
            ip: typeof ip === 'string' ? ip : '',
            countryCode: /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : '',
        };
    } catch {
        return {ip: '', countryCode: ''};
    }
}

function countryCodeToFlag(code) {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized))
        return '';

    return [...normalized]
        .map(char => String.fromCodePoint(0x1F1E6 + char.charCodeAt(0) - 65))
        .join('');
}

function loadCountryCache() {
    try {
        const text = readTextFile(COUNTRY_CACHE_PATH);
        if (!text)
            return new Map();

        const parsed = JSON.parse(text);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        const cache = new Map();

        for (const entry of entries) {
            const ip = typeof entry.ip === 'string' ? entry.ip : '';
            const countryCode = typeof entry.countryCode === 'string' ? entry.countryCode : '';
            const countryFlag = typeof entry.countryFlag === 'string' ? entry.countryFlag : '';
            const time = Number.isFinite(entry.time) ? entry.time : 0;

            if (ip && /^[A-Z]{2}$/.test(countryCode))
                cache.set(ip, {countryCode, countryFlag, time});
        }

        return cache;
    } catch {
        return new Map();
    }
}

function saveCountryCache(cache) {
    try {
        GLib.mkdir_with_parents(COUNTRY_CACHE_DIR, 0o700);

        const entries = [...cache.entries()].map(([ip, value]) => ({
            ip,
            countryCode: value.countryCode,
            countryFlag: value.countryFlag,
            time: value.time,
        }));
        const json = JSON.stringify({version: 1, entries}, null, 2);
        GLib.file_set_contents(COUNTRY_CACHE_PATH, json);
    } catch {
        // Cache persistence is best-effort; status display should not depend on it.
    }
}

const VpnIndicator = GObject.registerClass(
class VpnIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'VPN Status');

        this._settings = extension.getSettings();
        this._session = Soup.Session.new();
        this._session.timeout = GEOIP_TIMEOUT_SECONDS;
        this._timer = 0;
        this._settingsSignals = [];
        this._countryRequestRunning = false;
        this._lastCountryRefresh = 0;
        this._countryCache = loadCountryCache();

        this._state = {
            nmVpns: [],
            nmOpenvpn: [],
            nmWireguard: [],
            openvpnProcesses: [],
            wireguard: [],
            openvpn: [],
            tun: [],
            routes: [],
            clash: {active: false, ports: []},
            countryCode: '',
            countryFlag: '',
            countryStatus: 'not checked',
        };

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'network-offline-symbolic',
            style_class: 'system-status-icon',
        });
        this._box.add_child(this._icon);
        this._flagLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding-left: 4px;',
        });
        this._flagLabel.visible = false;
        this._box.add_child(this._flagLabel);
        this.add_child(this._box);

        this._clashItem = this._createStatusItem('Clash proxy: checking...');
        this._nmItem = this._createStatusItem('NetworkManager VPN: checking...');
        this._wgItem = this._createStatusItem('WireGuard: checking...');
        this._ovpnItem = this._createStatusItem('OpenVPN: checking...');
        this._tunItem = this._createStatusItem('TUN interface: checking...');
        this._routeItem = new PopupMenu.PopupMenuItem('Default route: checking...', {reactive: false});
        this._countryItem = new PopupMenu.PopupMenuItem('Proxy country: not checked', {reactive: false});
        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshCountryItem = new PopupMenu.PopupMenuItem('Refresh country');
        this._restartItem = new PopupMenu.PopupMenuItem('Restart monitor');

        this.menu.addMenuItem(this._clashItem);
        this.menu.addMenuItem(this._nmItem);
        this.menu.addMenuItem(this._wgItem);
        this.menu.addMenuItem(this._ovpnItem);
        this.menu.addMenuItem(this._tunItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._routeItem);
        this.menu.addMenuItem(this._countryItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._refreshItem);
        this.menu.addMenuItem(this._refreshCountryItem);
        this.menu.addMenuItem(this._restartItem);

        this._statusItems = [
            this._clashItem,
            this._nmItem,
            this._wgItem,
            this._ovpnItem,
            this._tunItem,
        ];

        this._refreshItem.connect('activate', () => this.refresh());
        this._refreshCountryItem.connect('activate', () => this.refreshCountry(true));
        this._restartItem.connect('activate', () => this.restartMonitor());
        this._settingsSignals.push(
            this._settings.connect('changed::show-indicator', () => this._syncVisibility()),
            this._settings.connect('changed::show-country-flag', () => this._render()),
            this._settings.connect('changed::geoip-url', () => this.refreshCountry(true))
        );

        this._syncVisibility();
        this.refresh();

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATUS_INTERVAL_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _createStatusItem(text) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item._dotLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 14px;',
        });
        item._textLabel = new St.Label({
            text,
            y_align: Clutter.ActorAlign.CENTER,
        });

        item.add_child(item._dotLabel);
        item.add_child(item._textLabel);
        return item;
    }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }

        for (const id of this._settingsSignals)
            this._settings.disconnect(id);

        this._settingsSignals = [];
        this._session.abort();
        super.destroy();
    }

    _syncVisibility() {
        this.visible = this._settings.get_boolean('show-indicator');
    }

    refresh() {
        const detected = detectInterfaces();
        const wasProxyActive = this._state.clash.active;

        this._state.wireguard = detected.wireguard;
        this._state.openvpn = detected.openvpn;
        this._state.tun = detected.tun;
        this._state.routes = detectDefaultRoutes();
        this._state.clash = detectClashProxy();
        const nmVpns = this._getNetworkManagerVpns();
        this._state.nmVpns = nmVpns.all;
        this._state.nmOpenvpn = nmVpns.openvpn;
        this._state.nmWireguard = nmVpns.wireguard;
        this._state.openvpnProcesses = detectOpenVpnProcesses();

        if (!this._state.clash.active)
            this._clearCountry();

        this._render();

        if (this._state.clash.active && (!wasProxyActive || this._countryRefreshDue()))
            this.refreshCountry(false);
    }

    restartMonitor() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }

        this._countryRequestRunning = false;
        this.refresh();
        this.refreshCountry(true);

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATUS_INTERVAL_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _getNetworkManagerVpns() {
        try {
            const nm = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.NetworkManager',
                g_object_path: '/org/freedesktop/NetworkManager',
                g_interface_name: 'org.freedesktop.NetworkManager',
            });
            nm.init(null);

            const paths = variantDeepUnpack(nm.get_cached_property('ActiveConnections')) ?? [];
            const vpns = {
                all: [],
                openvpn: [],
                wireguard: [],
            };

            for (const path of paths) {
                const proxy = new Gio.DBusProxy({
                    g_connection: Gio.DBus.system,
                    g_name: 'org.freedesktop.NetworkManager',
                    g_object_path: path,
                    g_interface_name: 'org.freedesktop.NetworkManager.Connection.Active',
                });
                proxy.init(null);

                const id = variantDeepUnpack(proxy.get_cached_property('Id')) ?? String(path);
                const type = variantDeepUnpack(proxy.get_cached_property('Type')) ?? '';
                const vpn = variantDeepUnpack(proxy.get_cached_property('Vpn')) ?? false;
                const connectionPath = variantDeepUnpack(proxy.get_cached_property('Connection')) ?? null;
                const serviceType = connectionPath ? this._getNetworkManagerVpnServiceType(connectionPath) : '';
                const label = type ? `${id} (${type})` : id;

                if (vpn || type === 'vpn' || type === 'wireguard')
                    vpns.all.push(label);
                if (serviceType.includes('openvpn'))
                    vpns.openvpn.push(id);
                if (type === 'wireguard' || serviceType.includes('wireguard'))
                    vpns.wireguard.push(id);
            }

            return vpns;
        } catch {
            return {all: [], openvpn: [], wireguard: []};
        }
    }

    _getNetworkManagerVpnServiceType(connectionPath) {
        try {
            const proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.NetworkManager',
                g_object_path: connectionPath,
                g_interface_name: 'org.freedesktop.NetworkManager.Settings.Connection',
            });
            proxy.init(null);

            const result = proxy.call_sync('GetSettings', null, Gio.DBusCallFlags.NONE, 1000, null);
            const unpacked = variantDeepUnpack(result);
            const settings = Array.isArray(unpacked) ? unpacked[0] : unpacked;
            const vpnSettings = settings?.vpn ?? {};
            const serviceType = vpnSettings['service-type'];

            return typeof serviceType === 'string' ? serviceType.toLowerCase() : '';
        } catch {
            return '';
        }
    }

    _render() {
        const vpnActive = this._state.nmVpns.length > 0 ||
            this._state.nmWireguard.length > 0 ||
            this._state.nmOpenvpn.length > 0 ||
            this._state.openvpnProcesses.length > 0 ||
            this._state.wireguard.length > 0 ||
            this._state.openvpn.length > 0 ||
            this._state.tun.length > 0;
        const proxyActive = this._state.clash.active;

        if (vpnActive)
            this._icon.icon_name = 'network-vpn-symbolic';
        else if (proxyActive)
            this._icon.icon_name = 'network-transmit-receive-symbolic';
        else
            this._icon.icon_name = 'network-offline-symbolic';

        this._setStatusItem(
            this._clashItem,
            proxyActive,
            proxyActive ? `Clash proxy: ports ${this._state.clash.ports.join('/')}` : 'Clash proxy'
        );
        this._setStatusItem(
            this._nmItem,
            this._state.nmVpns.length > 0,
            this._state.nmVpns.length > 0 ? `NetworkManager VPN: ${this._state.nmVpns.join(', ')}` : 'NetworkManager VPN'
        );
        this._setStatusItem(
            this._wgItem,
            this._state.wireguard.length > 0 || this._state.nmWireguard.length > 0,
            this._formatDetectedText('WireGuard', this._state.wireguard, this._state.nmWireguard)
        );
        this._setStatusItem(
            this._ovpnItem,
            this._state.openvpn.length > 0 ||
                this._state.nmOpenvpn.length > 0 ||
                this._state.openvpnProcesses.length > 0,
            this._formatDetectedText('OpenVPN', this._state.openvpn, this._state.nmOpenvpn, this._state.openvpnProcesses)
        );
        this._setStatusItem(
            this._tunItem,
            this._state.tun.length > 0,
            this._state.tun.length > 0 ? `TUN interface: ${this._state.tun.join(', ')}` : 'TUN interface'
        );
        this._routeItem.label.text = this._state.routes.length > 0
            ? `Default route: ${this._state.routes.join(', ')}`
            : 'Default route: none';
        this._countryItem.label.text = `Proxy country: ${this._formatCountry()}`;
        this._syncStatusOrder();
        this._renderTopBarFlag();
    }

    _formatDetectedText(title, interfaces, nmConnections, processes = []) {
        const parts = [];
        if (interfaces.length > 0)
            parts.push(interfaces.join(', '));
        if (nmConnections.length > 0)
            parts.push(nmConnections.join(', '));
        if (processes.length > 0)
            parts.push(processes.join(', '));

        return parts.length > 0 ? `${title}: ${parts.join(', ')}` : title;
    }

    _setStatusItem(item, active, text) {
        item._vpnStatusActive = active;
        item._dotLabel.text = active ? '•' : '';
        item._dotLabel.set_style(active ? 'color: #2ec27e; font-weight: 700; min-width: 14px;' : 'min-width: 14px;');
        item._textLabel.text = text;
        item._textLabel.set_style(active ? 'color: #2ec27e; font-weight: 700;' : null);
    }

    _syncStatusOrder() {
        try {
            const box = this.menu.box;
            if (typeof box?.set_child_at_index !== 'function')
                return;

            const ordered = [
                ...this._statusItems.filter(item => item._vpnStatusActive),
                ...this._statusItems.filter(item => !item._vpnStatusActive),
            ];

            let index = 0;
            for (const item of ordered) {
                if (item.get_parent?.() === box)
                    box.set_child_at_index(item, index++);
            }
        } catch {
            // Ordering is cosmetic; never let it affect the status indicator itself.
        }
    }

    _countryRefreshDue() {
        const now = GLib.get_monotonic_time();
        return this._lastCountryRefresh === 0 ||
            (now - this._lastCountryRefresh) / 1000000 >= COUNTRY_REFRESH_SECONDS;
    }

    _clearCountry() {
        this._state.countryCode = '';
        this._state.countryFlag = '';
        this._state.countryStatus = 'proxy inactive';
        this._renderTopBarFlag();
    }

    _formatCountry() {
        if (this._state.countryFlag && this._state.countryCode)
            return `${this._state.countryFlag} ${this._state.countryCode}`;

        return this._state.countryStatus;
    }

    refreshCountry(force) {
        if (!this._settings.get_boolean('show-country-flag')) {
            this._state.countryStatus = 'disabled';
            this._render();
            return;
        }

        if (!this._state.clash.active) {
            this._clearCountry();
            this._render();
            return;
        }

        if (this._countryRequestRunning)
            return;

        if (!force && !this._countryRefreshDue())
            return;

        const url = this._settings.get_string('geoip-url').trim();
        if (!url) {
            this._state.countryStatus = 'GeoIP URL empty';
            this._render();
            return;
        }

        this._countryRequestRunning = true;
        this._state.countryStatus = 'checking...';
        this._render();

        const message = Soup.Message.new('GET', url);
        this._syncGeoIpProxy();
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const status = message.get_status();

                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);

                const text = new TextDecoder().decode(bytes.get_data());
                const geo = parseGeoIp(text);
                const cached = geo.ip ? this._countryCache.get(geo.ip) : null;
                const code = cached?.countryCode ?? geo.countryCode ?? parseCountryCode(text);
                const flag = code ? countryCodeToFlag(code) : '';

                this._state.countryCode = code;
                this._state.countryFlag = flag;
                this._state.countryStatus = code ? `${flag} ${code}` : 'unknown';
                this._lastCountryRefresh = GLib.get_monotonic_time();

                if (geo.ip && code)
                    this._rememberCountry(geo.ip, code, flag);
            } catch {
                this._state.countryCode = '';
                this._state.countryFlag = '';
                this._state.countryStatus = 'lookup failed';
            } finally {
                this._countryRequestRunning = false;
                this._render();
            }
        });
    }

    _rememberCountry(ip, countryCode, countryFlag) {
        if (this._countryCache.has(ip))
            this._countryCache.delete(ip);

        this._countryCache.set(ip, {
            countryCode,
            countryFlag,
            time: GLib.get_monotonic_time(),
        });

        while (this._countryCache.size > COUNTRY_CACHE_LIMIT) {
            const oldestKey = this._countryCache.keys().next().value;
            this._countryCache.delete(oldestKey);
        }

        saveCountryCache(this._countryCache);
    }

    _syncGeoIpProxy() {
        const port = this._state.clash.ports[0] ?? 0;
        if (!port)
            return;

        try {
            const resolver = Gio.SimpleProxyResolver.new(`http://127.0.0.1:${port}`, null);
            this._session.set_proxy_resolver(resolver);
        } catch {
            // If proxy setup fails, libsoup falls back to the normal network path.
        }
    }

    _renderTopBarFlag() {
        const show = this._settings.get_boolean('show-country-flag') && this._state.countryFlag;
        this._flagLabel.visible = Boolean(show);
        this._flagLabel.text = show ? this._state.countryFlag : '';
    }
});

export default class VpnStatusExtension extends Extension {
    enable() {
        this._indicator = new VpnIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
