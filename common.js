// Wspólne dla overlay.html i panel.html: domyślna konfiguracja, formatowanie
// i szyna wiadomości przez ntfy.sh (publiczny pub/sub, bez własnego serwera).
//
// Protokół (każda wiadomość to JSON z polem `t`):
//   config  – panel → overlay, pełna konfiguracja            (cache 12h)
//   count   – poller → wszyscy, liczba wishlist ze Steama    (cache 12h)
//   status  – overlay → panel, stan overlaya + konfiguracja  (cache 12h)
//   poller  – poller → panel, błędy/odzyskanie               (cache 12h)
//   cmd     – panel → overlay, jednorazowe polecenia         (BEZ cache, tylko na żywo)
(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    step: 100,              // co ile wishlist jest próg
    barToGoal: false,       // pasek celuje w najbliższy cel zamiast w próg
    minUptimeMin: 10,       // ile minut streama musi minąć, zanim animacja poleci
    requireStream: true,    // animacja tylko gdy OBS streamuje
    alertsEnabled: true,    // false = kolejka czeka, nic nie leci
    showBar: true,          // pasek postępu do następnego progu
    showToday: true,        // „+123 dziś”
    widgetStyle: 'pixel',   // wygląd ramki widgetu
    widgetPos: 'top-right',
    widgetScale: 1,
    widgetX: 0,             // przesunięcie względem rogu: + w prawo
    widgetY: 0,             // + w dół
    goals: [],              // [{n: 5000, text: 'nowa gra na streamie'}] – przewijają się w widgecie
    goalAlertEnabled: true, // animacja po zdobyciu celu
    goalAlertLabel: 'CEL ZDOBYTY!',
    goalAlertStamp: 'ZROBIONE',
    barSeconds: 60,         // jak długo widać pasek postępu
    goalSeconds: 10,        // jak długo widać jeden cel
    showSteamTag: true,     // plakietka „STEAM: …” pod ramką, po przeciwnej stronie
    steamTagText: 'STEAM: GAME KEEPER',
    todayPos: 'below',      // gdzie licznik „+X dziś” względem paska
    alertPos: 'center',     // gdzie leci animacja progu
    alertScale: 1,          // 1 = cały ekran
    logoScale: 1,           // wielkość loga względem reszty animacji
    offset: 0,              // korekta względem Steamworks
    volume: 0.6,
    headline: 'LEVEL UP!',
    subtitle: 'PRZEBILIŚMY KOLEJNY PRÓG!',
    unitLabel: 'WISHLIST',
    widgetTitle: 'WISHLISTY',
  };

  const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'];
  const STYLES = ['pixel', 'modern', 'glass', 'neon', 'minimal', 'paper', 'arcade', 'terminal', 'sunset', 'outline', 'light', 'vhs'];

  function normalizeConfig(cfg) {
    const c = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    c.step = Math.max(1, Math.round(Number(c.step) || DEFAULT_CONFIG.step));
    c.minUptimeMin = Math.max(0, Number(c.minUptimeMin) || 0);
    c.offset = Math.round(Number(c.offset) || 0);
    c.volume = Math.min(1, Math.max(0, Number(c.volume)));
    if (!Number.isFinite(c.volume)) c.volume = DEFAULT_CONFIG.volume;
    c.widgetScale = Math.min(3, Math.max(0.2, Number(c.widgetScale) || 1));
    c.widgetX = Math.max(-1900, Math.min(1900, Math.round(Number(c.widgetX) || 0)));
    c.widgetY = Math.max(-1060, Math.min(1060, Math.round(Number(c.widgetY) || 0)));
    c.alertScale = Math.min(1.2, Math.max(0.25, Number(c.alertScale) || 1));
    c.logoScale = Math.min(2.5, Math.max(0.5, Number(c.logoScale) || 1));
    for (const k of ['requireStream', 'alertsEnabled', 'showBar', 'showToday', 'goalAlertEnabled', 'showSteamTag', 'barToGoal']) c[k] = !!c[k];
    for (const k of ['headline', 'subtitle', 'unitLabel', 'widgetTitle', 'goalAlertLabel', 'goalAlertStamp', 'steamTagText']) {
      c[k] = String(c[k] ?? DEFAULT_CONFIG[k]).slice(0, 80);
    }
    if (!POSITIONS.includes(c.widgetPos)) c.widgetPos = DEFAULT_CONFIG.widgetPos;
    if (!STYLES.includes(c.widgetStyle)) c.widgetStyle = DEFAULT_CONFIG.widgetStyle;
    if (!['below', 'above', 'left', 'right'].includes(c.todayPos)) c.todayPos = DEFAULT_CONFIG.todayPos;
    c.goalSeconds = Math.min(600, Math.max(3, Number(c.goalSeconds) || DEFAULT_CONFIG.goalSeconds));
    c.barSeconds = Math.min(600, Math.max(3, Number(c.barSeconds) || DEFAULT_CONFIG.barSeconds));
    c.goals = (Array.isArray(c.goals) ? c.goals : [])
      .map((g) => ({ n: Math.round(Number(g && g.n)), text: String((g && g.text) || '').slice(0, 60) }))
      .filter((g) => Number.isFinite(g.n) && g.n > 0)
      .sort((a, b) => a.n - b.n)
      .slice(0, 12);
    if (!POSITIONS.includes(c.alertPos) && c.alertPos !== 'center') c.alertPos = DEFAULT_CONFIG.alertPos;
    return c;
  }

  function readParams() {
    const h = new URLSearchParams(location.hash.slice(1));
    const q = new URLSearchParams(location.search);
    const get = (k) => h.get(k) ?? q.get(k);
    return {
      topic: (get('topic') || '').trim(),
      server: (get('server') || 'https://ntfy.sh').replace(/\/+$/, ''),
      server2: (get('server2') || BACKUP_SERVER).replace(/\/+$/, ''),   // zapasowy; 'off' wyłącza
      token: (get('token') || '').trim(),
      debug: get('debug') === '1',
      preview: get('preview') === '1',
      style: get('style') || '',      // podgląd wybranego stylu ramki
      fake: get('fake') === '1',      // podgląd bez ntfy, na przykładowych danych
    };
  }

  // 8432 → "8 432"
  function fmt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return n < 0 ? '-' + s : s;
  }

  function tierOf(total, step) {
    return Math.floor(total / step) * step;
  }

  function randomTopic() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return 'gk-wishlist-' + Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  }

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {}
    },
  };

  // Łączność: słuchamy na kilku serwerach naraz, a wysyłamy tym, który działa.
  // Dzięki temu wyczerpany limit jednego serwera nie blokuje sterowania.
  const BACKUP_SERVER = 'https://ntfy.envs.net';

  function authQuery(token) {
    if (!token) return '';
    const b64 = btoa('Bearer ' + token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return '&auth=' + b64;
  }

  class Bus {
    constructor({ servers, server, topic, token, onMessage, onState }) {
      this.servers = (servers || [server]).filter(Boolean);
      this.topic = topic;
      this.token = token || '';
      this.onMessage = onMessage;
      this.onState = onState || (() => {});
      this.conns = this.servers.map(() => ({ es: null, lastId: null, retry: 1000, open: false }));
      this.seen = new Set();
      this.preferred = 0;
    }

    get connected() { return this.conns.some((c) => c.open); }
    // token dotyczy tylko konta na serwerze głównym
    tokenFor(i) { return i === 0 ? this.token : ''; }

    connect() { this.servers.forEach((srv, i) => this.connectOne(i)); }

    // zmiana tokenu w locie: przelogowujemy nasłuch na serwerze głównym
    setToken(token) {
      this.token = token || '';
      const c = this.conns[0];
      if (!c) return;
      const old = c.es;
      c.es = null;
      c.retry = 1000;
      if (old) old.close();
      this.connectOne(0);
    }

    connectOne(i) {
      const c = this.conns[i];
      const url = `${this.servers[i]}/${encodeURIComponent(this.topic)}/sse?since=${encodeURIComponent(c.lastId || '12h')}${authQuery(this.tokenFor(i))}`;
      const es = new EventSource(url);
      c.es = es;
      es.addEventListener('open', () => {
        c.retry = 1000;
        c.open = true;
        this.onState('open');
      });
      es.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.event !== 'message' || !m.id) return;
        c.lastId = m.id;
        let body;
        try { body = JSON.parse(m.message); } catch (e) { return; }
        if (!body || typeof body.t !== 'string') return;
        // ta sama wiadomość może przyjść z obu serwerów – porównujemy całą treść
        if (this.seen.has(m.message)) return;
        this.seen.add(m.message);
        if (this.seen.size > 200) this.seen = new Set(Array.from(this.seen).slice(-100));
        try {
          this.onMessage(body, { id: m.id, time: m.time * 1000, server: this.servers[i] });
        } catch (e) {
          console.error('Błąd obsługi wiadomości', e, body);
        }
      };
      es.onerror = () => {
        es.close();
        if (c.es !== es) return;
        c.open = false;
        this.onState('closed');
        setTimeout(() => this.connectOne(i), c.retry);
        c.retry = Math.min(c.retry * 2, 30000);
      };
    }

    async post(i, body, cache) {
      const headers = { 'X-Firebase': 'no' };
      if (!cache) headers['X-Cache'] = 'no';
      const token = this.tokenFor(i);
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(`${this.servers[i]}/${encodeURIComponent(this.topic)}`, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      return res.json();
    }

    async publish(obj, { cache = true } = {}) {
      const body = JSON.stringify(Object.assign({ ts: Date.now() }, obj));
      let last = null;
      for (let k = 0; k < this.servers.length; k++) {
        const i = (this.preferred + k) % this.servers.length;
        try {
          const out = await this.post(i, body, cache);
          this.preferred = i;
          return out;
        } catch (e) {
          last = e;
          if (!/ntfy (401|403|429|5\d\d)|Failed|NetworkError|load failed/i.test(e.message)) throw e;
        }
      }
      throw last || new Error('ntfy niedostępne');
    }
  }

  global.WL = { DEFAULT_CONFIG, STYLES, BACKUP_SERVER, normalizeConfig, readParams, fmt, tierOf, randomTopic, store, Bus };
})(window);
