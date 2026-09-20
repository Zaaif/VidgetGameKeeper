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
    barSeconds: 60,         // jak długo widać pasek postępu
    goalSeconds: 10,        // jak długo widać jeden cel
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
    c.widgetScale = Math.min(3, Math.max(0.3, Number(c.widgetScale) || 1));
    c.widgetX = Math.max(-1900, Math.min(1900, Math.round(Number(c.widgetX) || 0)));
    c.widgetY = Math.max(-1060, Math.min(1060, Math.round(Number(c.widgetY) || 0)));
    c.alertScale = Math.min(1.2, Math.max(0.25, Number(c.alertScale) || 1));
    c.logoScale = Math.min(2.5, Math.max(0.5, Number(c.logoScale) || 1));
    for (const k of ['requireStream', 'alertsEnabled', 'showBar', 'showToday']) c[k] = !!c[k];
    for (const k of ['headline', 'subtitle', 'unitLabel', 'widgetTitle']) c[k] = String(c[k] ?? DEFAULT_CONFIG[k]).slice(0, 80);
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

  // Subskrypcja SSE z ręcznym wznawianiem od ostatniego id (żeby po zerwaniu
  // nie odtwarzać całego 12-godzinnego cache) i deduplikacją.
  class Bus {
    constructor({ server, topic, onMessage, onState }) {
      this.server = server;
      this.topic = topic;
      this.onMessage = onMessage;
      this.onState = onState || (() => {});
      this.lastId = null;
      this.seen = new Set();
      this.es = null;
      this.retry = 1000;
      this.connected = false;
    }

    connect() {
      const since = this.lastId || '12h';
      const url = `${this.server}/${encodeURIComponent(this.topic)}/sse?since=${encodeURIComponent(since)}`;
      const es = new EventSource(url);
      this.es = es;
      es.addEventListener('open', () => {
        this.retry = 1000;
        this.connected = true;
        this.onState('open');
      });
      es.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (m.event !== 'message' || !m.id || this.seen.has(m.id)) return;
        this.seen.add(m.id);
        if (this.seen.size > 2000) this.seen = new Set(Array.from(this.seen).slice(-1000));
        this.lastId = m.id;
        let body;
        try {
          body = JSON.parse(m.message);
        } catch (e) {
          return; // nie nasza wiadomość (np. ktoś wysłał tekst z aplikacji ntfy)
        }
        if (!body || typeof body.t !== 'string') return;
        try {
          this.onMessage(body, { id: m.id, time: m.time * 1000 });
        } catch (e) {
          console.error('Błąd obsługi wiadomości', e, body);
        }
      };
      es.onerror = () => {
        es.close();
        if (this.es !== es) return;
        this.connected = false;
        this.onState('closed');
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      };
    }

    async publish(obj, { cache = true } = {}) {
      const headers = { 'X-Firebase': 'no' };
      if (!cache) headers['X-Cache'] = 'no';
      const res = await fetch(`${this.server}/${encodeURIComponent(this.topic)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(Object.assign({ ts: Date.now() }, obj)),
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      return res.json();
    }
  }

  global.WL = { DEFAULT_CONFIG, STYLES, normalizeConfig, readParams, fmt, tierOf, randomTopic, store, Bus };
})(window);
