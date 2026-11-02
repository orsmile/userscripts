// ==UserScript==
// @name         FNA replay
// @name:zh-TW   Meta 圖片載入觀測
// @namespace    gl-mt5000-tuning
// @version      0.6.1
// @description  Replays the Meta images and videos you load against HiNet's FNA caches and logs how long a first and a repeat fetch take
// @description:zh-TW 瀏覽 FB、IG、Threads 時，記錄圖片和影片載入要等多久，並比較尖峰與離峰時段
// @match        https://www.facebook.com/*
// @match        https://web.facebook.com/*
// @match        https://www.instagram.com/*
// @match        https://www.threads.com/*
// @match        https://www.threads.net/*
// @updateURL    https://raw.githubusercontent.com/orsmile/userscripts/main/fna-replay.user.js
// @downloadURL  https://raw.githubusercontent.com/orsmile/userscripts/main/fna-replay.user.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      stat.ripe.net
// ==/UserScript==

// While you browse, every few seconds one media object the page loaded (from
// whatever CDN host Meta gave you) is logged as four rows:
//   page    the page's own load of it, from resource timing: what you waited
//           for, including a slow fill on the page's host
//   ctl     fetched again from the host the page used; the page just loaded
//           it, so this is a cache hit there
//   first   from one of HiNet's FNA nodes, by swapping the host name
//   repeat  the same again from that node
// A slow "first" with a fast "repeat" is a slow fill on that node, i.e. the
// object was not cached there and fetching it upstream was slow.  The signed
// URLs are not tied to a host name.  Only timings, sizes and status codes are
// stored, never the URLs.  Results stay in Tampermonkey storage; the panel
// (button at the bottom left, or the menu) compares peak and off-peak hours
// and copies the rows as JSON or CSV.
// Each row also carries the network (ASN) the browser is on, looked up from
// RIPEstat every few minutes.  Only the ASN and its name are kept, not the IP.

(function () {
    'use strict';

    // HiNet-hosted FNA nodes (203.74.65/69/76.x).  The scontent, instagram and
    // video names on one node appear to share a cache.
    const NODES = ['ftpe7-1', 'ftpe7-2', 'ftpe7-3', 'ftpe7-4',
                   'ftpe8-1', 'ftpe8-2', 'ftpe8-3', 'ftpe8-4',
                   'fkhh1-1', 'fkhh1-2'];
    const MIN_GAP_MS = 6000;
    const QUEUE_MAX = 30;
    const TIMEOUT_MS = 45000;
    const MAX_BYTES = 4 << 20;
    const MAX_ROWS = 6000;
    const SLOW_MS = 1000;
    const KEY_ROWS = 'rows';
    // Local hours [start, end) counted as the evening peak.  HiNet's fills
    // were worst around 21:30-22:00 on 2026-10-27/29/30.
    const PEAK_START = 20;
    const PEAK_END = 24;
    // Verdicts need this many samples on each side; heatmap cells this many.
    const MIN_VERDICT = 20;
    const MIN_CELL = 3;
    // Days shown in the per-day heatmap and table (the export keeps every day).
    const DAY_ROWS = 14;
    const VERSION = '0.6.1';
    const NET_REFRESH_MS = 10 * 60000;
    // Short names for Taiwanese ASNs, from TWNIC's registry (map.twnic.tw)
    // and RIPE's AS names on 2026-11-01.  Any other ASN shows its registry
    // holder name.
    const AS_NAMES = {
        // Telcos, fixed and mobile
        3462: '中華電信 HiNet', 17421: '中華電信 emome',
        9674: '遠傳', 4780: '遠傳 Seednet',
        24158: '台灣大哥大', 131614: '台灣大哥大', 131647: '台灣大哥大', 131648: '台灣大哥大',
        131649: '台灣大哥大', 131650: '台灣大哥大',
        9924: '台灣固網', 4636: '台灣固網', 4747: '台灣固網',
        17709: '亞太電信', 24154: '亞太電信', 24155: '亞太電信', 24157: '台灣之星',
        9919: '新世紀資通', 24161: '新世紀資通', 7482: 'APOL', 18182: 'So-net',
        131584: '台灣智慧光網',
        // Cable operators
        38841: '凱擘 kbro', 9416: '中嘉', 18042: '中嘉', 24166: '中嘉',
        131596: '台灣寬頻 TBC', 18419: '大大寬頻', 18413: '大台北寬頻', 18049: '台基科 TINP',
        17809: '大台中數位', 18429: '大新店寬頻', 9922: '新高雄寬頻',
    };

    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const site = location.hostname.replace(/^www\./, '');
    const seen = new Set();
    const queue = [];
    let paused = GM_getValue('paused', false);
    let busy = false;
    let lastRun = 0;
    // Network the browser is on now: { asn, name }.  Kept in memory only, so
    // a stale value from another network is never written into rows.
    let net = null;

    function ripe(path) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'GET',
            url: `https://stat.ripe.net/data/${path}${path.includes('?') ? '&' : '?'}sourceapp=fna-replay`,
            timeout: 15000,
            anonymous: true,
            onload: r => { try { resolve(JSON.parse(r.responseText).data); } catch (e) { reject(e); } },
            onerror: reject,
            ontimeout: reject,
        }));
    }

    // The IP is used for the second lookup and then dropped.  It is the
    // address RIPEstat sees, so a VPN or split routing can make it differ
    // from the one Meta sees; the host Meta hands out tells that apart.
    async function detectNet() {
        try {
            const ip = (await ripe('whats-my-ip/data.json')).ip;
            const a = ((await ripe('prefix-overview/data.json?resource=' + encodeURIComponent(ip))).asns || [])[0];
            net = a ? { asn: a.asn, name: AS_NAMES[a.asn] || a.holder } : { asn: '', name: '未知網路' };
        } catch (e) {
            net = { asn: '', name: '偵測失敗' };
        }
        ui.update(GM_getValue(KEY_ROWS, []));
    }

    function isMedia(url) {
        let u;
        try { u = new URL(url); } catch (e) { return null; }
        if (!/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(u.hostname)) return null;
        if (/^static\./.test(u.hostname)) return null;
        if (!/^\/(v|o1\/v)\//.test(u.pathname)) return null;
        return u;
    }

    // The page's own load, from its resource timing entry (fbcdn sends
    // Timing-Allow-Origin, so the detailed fields are filled in).
    function pageTiming(e) {
        const ttfb = e.responseStart > 0 ? e.responseStart - e.startTime : e.duration;
        const body = e.responseStart > 0 ? e.responseEnd - e.responseStart : 0;
        const bytes = e.encodedBodySize;
        return {
            status: e.responseStatus ? String(e.responseStatus) : '',
            ttfb: Math.round(ttfb),
            total: Math.round(e.duration),
            bytes,
            kbps: bytes >= 32768 && body > 0 ? Math.round(bytes * 8 / body) : '',
            xfer: e.transferSize,
            sw: e.workerStart > 0 ? 1 : 0,
            proto: e.nextHopProtocol,
        };
    }

    function onEntry(e) {
        const u = isMedia(e.name);
        if (!u || seen.has(u.pathname)) return;
        seen.add(u.pathname);
        queue.push({ href: u.href, page: pageTiming(e) });
        if (queue.length > QUEUE_MAX) queue.shift();
    }

    // Times one GET: TTFB when headers arrive, total after the body (cut at
    // MAX_BYTES).  "no-store" keeps the browser cache out; FNA still serves
    // its own cached copies (6-16 ms hits on 2026-10-22).
    async function timeFetch(href) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        const t0 = performance.now();
        let ttfb = -1, bytes = 0, status = 'err';
        try {
            const r = await fetch(href, { cache: 'no-store', credentials: 'omit', signal: ac.signal });
            ttfb = performance.now() - t0;
            status = String(r.status);
            const reader = r.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes >= MAX_BYTES) { await reader.cancel(); break; }
            }
        } catch (e) {
            status = ac.signal.aborted ? 'timeout' : 'err';
        } finally {
            clearTimeout(timer);
        }
        const total = performance.now() - t0;
        const body = total - (ttfb < 0 ? total : ttfb);
        // Resource timing of this request (fbcdn sends Timing-Allow-Origin):
        // xfer 0 with bytes > 0 means a cache answered, sw 1 a service worker.
        const e = W.performance.getEntriesByName(href, 'resource').pop();
        return {
            status,
            ttfb: Math.round(ttfb < 0 ? total : ttfb),
            total: Math.round(total),
            bytes,
            kbps: bytes >= 32768 && body > 0 ? Math.round(bytes * 8 / body) : '',
            xfer: e ? e.transferSize : '',
            sw: e ? (e.workerStart > 0 ? 1 : 0) : '',
            proto: e ? e.nextHopProtocol : '',
        };
    }

    function shortHost(h) {
        const m = h.match(/^(?:scontent|video|instagram)[.-]([a-z0-9-]+)\.(?:xx\.|fna\.)?(?:fbcdn\.net|cdninstagram\.com)$/);
        return m ? m[1] : h;
    }

    async function sampleOne(item) {
        const u = new URL(item.href);
        const kind = /^\/o1\/v\//.test(u.pathname) || /^video/.test(u.hostname) ? 'video' : 'image';
        const n = GM_getValue('next_node', 0) % NODES.length;
        GM_setValue('next_node', n + 1);
        const node = NODES[n];
        const fna = new URL(item.href);
        fna.hostname = (kind === 'video' ? 'video.' : 'scontent.') + node + '.fna.fbcdn.net';
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const ts = new Date().toISOString();
        const base = { ts, id, site, kind, node, ctl_host: shortHost(u.hostname), asn: net.asn, as_name: net.name };
        const rows = [Object.assign({ test: 'page' }, base, item.page)];
        rows.push(Object.assign({ test: 'ctl' }, base, await timeFetch(u.href)));
        rows.push(Object.assign({ test: 'first' }, base, await timeFetch(fna.href)));
        rows.push(Object.assign({ test: 'repeat' }, base, await timeFetch(fna.href)));
        const all = GM_getValue(KEY_ROWS, []);
        all.push(...rows);
        if (all.length > MAX_ROWS) all.splice(0, all.length - MAX_ROWS);
        GM_setValue(KEY_ROWS, all);
        const [p, c, f, r] = rows;
        console.debug(`[fna-replay] ${kind} ${node}: page ${p.ttfb}/${p.total} ms, ctl ${c.status} ${c.ttfb} ms, first ${f.status} ${f.ttfb}/${f.total} ms, repeat ${r.status} ${r.ttfb} ms, ${f.bytes} B`);
        ui.update(all);
    }

    async function tick() {
        // Only the visible tab samples: background tabs get their timers cut
        // to once a minute, and several tabs writing the shared row list at
        // once would overwrite each other's rows.
        if (paused || busy || !net || document.visibilityState !== 'visible' || !queue.length ||
            Date.now() - lastRun < MIN_GAP_MS) return;
        busy = true;
        lastRun = Date.now();
        // Newest first: what is on screen now.
        const item = queue.pop();
        try { await sampleOne(item); } catch (e) { console.debug('[fna-replay]', e); }
        busy = false;
    }

    // ---- analysis -------------------------------------------------------

    function pct(sorted, p) {
        if (!sorted.length) return null;
        return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
    }

    const isOk = r => r.status === '200' || r.status === '206';
    // The browser's own cache answered: nothing crossed the network.
    const isCached = r => r.xfer === 0 && r.bytes > 0;
    const isPeak = h => h >= PEAK_START && h < PEAK_END;
    // A page load has no failure state we can see; a replay fails on an error
    // status or the timeout, which counts as slow too.
    const isSlow = r => r.test === 'page' ? r.total >= SLOW_MS : !isOk(r) || r.total >= SLOW_MS;

    function stat(list) {
        const t = list.filter(r => r.test === 'page' || isOk(r)).map(r => r.total).sort((a, b) => a - b);
        const slow = list.filter(isSlow).length;
        return {
            n: list.length,
            slow,
            fail: list.filter(r => r.test !== 'page' && !isOk(r)).length,
            slow_pct: list.length ? Math.round(slow * 1000 / list.length) / 10 : null,
            p50: pct(t, 0.5),
            p90: pct(t, 0.9),
        };
    }

    function verdict(peak, off) {
        if (peak.n < MIN_VERDICT || off.n < MIN_VERDICT) {
            return { level: 'insufficient', text: `樣本還不夠（尖峰 ${peak.n} 筆、離峰 ${off.n} 筆，各要 ${MIN_VERDICT} 筆以上）` };
        }
        const p = peak.slow / peak.n, o = off.slow / off.n;
        if (p >= 0.10 && p >= 2 * o) return { level: 'peak', text: '只有尖峰時段會卡' };
        if (p >= 0.10 && o >= 0.10) return { level: 'all', text: '整天都會卡' };
        if (p < 0.05 && o < 0.05) return { level: 'ok', text: '沒有明顯卡頓' };
        return { level: 'mixed', text: '偶爾會慢，但跟尖峰時段沒有明顯關係' };
    }

    function operator(host) {
        if (/^(ftpe7|ftpe8|fkhh1)-\d/.test(host)) return 'HiNet';
        // Seen with a Seednet exit on 2026-10-27 (139.175.92.24).
        if (/^ftpe21-\d/.test(host)) return 'Seednet';
        return '';
    }

    function summarize(rows) {
        const page = rows.filter(r => r.test === 'page' && !isCached(r));
        const first = rows.filter(r => r.test === 'first');
        const hourOf = r => new Date(r.ts).getHours();
        const split = list => {
            const peak = stat(list.filter(r => isPeak(hourOf(r))));
            const offpeak = stat(list.filter(r => !isPeak(hourOf(r))));
            return { peak, offpeak, verdict: verdict(peak, offpeak) };
        };
        const byHour = [];
        for (let h = 0; h < 24; h++) {
            byHour.push({ hour: h, page: stat(page.filter(r => hourOf(r) === h)),
                          first: stat(first.filter(r => hourOf(r) === h)) });
        }
        // Local calendar date; the peak window (20-24) never crosses midnight.
        const dayOf = r => new Date(r.ts).toLocaleDateString('sv');
        const days = [...new Set(first.map(dayOf))].sort();
        const byDay = days.map(d => {
            const dp = page.filter(r => dayOf(r) === d), df = first.filter(r => dayOf(r) === d);
            const hours = [];
            for (let h = 0; h < 24; h++) {
                hours.push({ hour: h, page: stat(dp.filter(r => hourOf(r) === h)),
                             first: stat(df.filter(r => hourOf(r) === h)) });
            }
            return { date: d, samples: df.length, page: split(dp), first: split(df), by_hour: hours };
        });
        const hosts = {};
        for (const r of page) (hosts[r.ctl_host] = hosts[r.ctl_host] || []).push(r);
        const pageHosts = Object.keys(hosts)
            .map(h => Object.assign({ host: h, operator: operator(h) }, stat(hosts[h])))
            .sort((a, b) => b.n - a.n);
        const nodes = {};
        for (const r of rows) {
            if (r.test === 'first' || r.test === 'repeat') {
                const k = r.node + ' ' + r.kind;
                (nodes[k] = nodes[k] || { first: [], repeat: [] })[r.test].push(r);
            }
        }
        const byNode = Object.keys(nodes).sort().map(k => {
            const [node, kind] = k.split(' ');
            const rep = nodes[k].repeat.filter(isOk).map(r => r.total).sort((a, b) => a - b);
            return Object.assign({ node, kind }, stat(nodes[k].first), { repeat_p50: pct(rep, 0.5) });
        });
        return {
            samples: first.length,
            browser_cached_page_loads: rows.filter(r => r.test === 'page' && isCached(r)).length,
            from: rows.length ? rows[0].ts : null,
            to: rows.length ? rows[rows.length - 1].ts : null,
            page: split(page),
            first: split(first),
            by_hour: byHour,
            by_day: byDay,
            page_hosts: pageHosts,
            by_node: byNode,
        };
    }

    // Rows from before 0.5 have no asn; they group under their label, if any.
    const netKey = r => r.asn ? 'AS' + r.asn : (r.as_name || r.isp || '未偵測');
    const netLabel = r => r.asn ? `${r.as_name}（AS${r.asn}）` : (r.as_name || r.isp || '未偵測');

    function networks(rows) {
        const m = {};
        for (const r of rows) {
            if (r.test !== 'first') continue;
            const k = netKey(r);
            (m[k] = m[k] || { key: k, label: netLabel(r), samples: 0 }).samples++;
        }
        return Object.values(m).sort((a, b) => b.samples - a.samples);
    }

    // ---- export ---------------------------------------------------------

    const CSV_COLS = ['ts', 'id', 'site', 'kind', 'node', 'ctl_host', 'test', 'status', 'ttfb', 'total', 'bytes', 'kbps',
                      'xfer', 'sw', 'proto', 'asn', 'as_name'];

    function csvCell(v) {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function csvText(rows) {
        return [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(c => csvCell(r[c])).join(','))).join('\n');
    }

    function jsonText(rows) {
        return JSON.stringify({
            tool: 'fna-replay',
            version: VERSION,
            exported_at: new Date().toISOString(),
            time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            utc_offset_min: -new Date().getTimezoneOffset(),
            network_now: net,
            peak_hours_local: [PEAK_START, PEAK_END],
            slow_ms: SLOW_MS,
            hinet_nodes: NODES,
            notes: {
                rows: 'Four rows per sample, sharing ts and id. ts is UTC.',
                page: "The page's own load of the object (resource timing): what the user waited for, from ctl_host.",
                ctl: 'The same object fetched again from ctl_host right after the page loaded it, so a cache hit there.',
                first: 'The same object fetched from one HiNet FNA node (node); slow first with fast repeat means a slow cache fill.',
                repeat: 'The first fetch again from the same node; normally a hit.',
                ttfb_total: 'Milliseconds to the first byte and to the end of the body (cut at 4 MiB).',
                status: 'HTTP status, or timeout (45 s) / err. page rows may have an empty status.',
                xfer: 'Resource timing transferSize; 0 with bytes > 0 means the browser cache answered (excluded from page stats).',
                asn: 'Network the browser was on for the sample, from RIPEstat (whats-my-ip, then prefix-overview); as_name is a short name or the registry holder. A VPN or split routing can make Meta see a different network: compare ctl_host.',
                summary: 'Computed by the script: page excludes browser-cache hits; slow means total >= slow_ms, or a failed replay.',
                summary_by_network: 'The same summary over the rows of each network only.',
                by_day: 'summary.by_day splits by local date (time_zone): per-day peak/off-peak split, verdict and 24 hourly cells.',
            },
            networks: networks(rows),
            summary: summarize(rows),
            summary_by_network: Object.fromEntries(networks(rows).map(n => [n.key, summarize(rows.filter(r => netKey(r) === n.key))])),
            rows,
        }, null, 1);
    }

    // Saves text as a file; a few thousand rows are too big to paste comfortably.
    function download(text, ext, type) {
        const stamp = new Date().toLocaleString('sv').slice(0, 16).replace(/[-: ]/g, '');
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `fna-replay-${stamp}.${ext}`;
        a.style.display = 'none';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    const downloadJson = () => download(jsonText(GM_getValue(KEY_ROWS, [])), 'json', 'application/json');
    const downloadCsv = () => download(csvText(GM_getValue(KEY_ROWS, [])), 'csv', 'text/csv');

    // ---- panel ----------------------------------------------------------

    const TIPS = {
        page: '你的瀏覽器實際載入這張圖或影片花的時間，也就是你真正等待的時間。已經在瀏覽器快取裡的不算。',
        first: '把同一張圖改向中華電信 HiNet 的 Meta 快取主機（FNA 節點）抓一次。主機上沒有這張圖時要先去 Meta 那邊補，補得慢就會超過 1 秒。',
        repeat: '緊接著同一台主機再抓一次。這時通常已經有快取，很快。第一次慢、重抓快，就代表是補檔慢。',
        peak: `晚上 ${PEAK_START}:00 到 ${PEAK_END === 24 ? '24:00' : PEAK_END + ':00'}，大家都在上網的時段。其餘時間算離峰。`,
        p50: '中位數：一半的載入比這個快，一半比這個慢。',
        p90: 'P90：90% 的載入比這個快，代表「比較慢的那一成」大概多慢。',
        slow: `載入超過 ${SLOW_MS / 1000} 秒的比例。超過 1 秒時，滑動時會明顯看到圖片還沒出來。`,
        fail: `抓不到（錯誤）或等了 ${TIMEOUT_MS / 1000} 秒還沒抓完的次數，也算在慢的裡面。`,
        node: 'FNA 節點：Meta 放在各家網路業者機房裡的快取主機。名稱像 ftpe7-2，ftpe 是台北、fkhh 是高雄。Meta 會依你的網路業者分配。',
        host: 'Meta 分給你的圖片主機。用中華電信的人通常是 ftpe7、ftpe8 或 fkhh1，其他業者會拿到不同的名稱。',
        net: '自動偵測你現在連線所屬的網路（ASN，網路業者的編號），每 10 分鐘更新一次，換網路（例如改用手機熱點）也會跟著變。只保存業者編號和名稱，不保存 IP。\n有開 VPN 或分流時，Meta 看到的可能是另一個網路，可以對照下面「Meta 分給你的主機」。',
        netfilter: '資料裡有不同網路時，可以只看其中一個，避免混在一起影響結論。預設是現在的網路。',
        heat: `每格是一小時（依你電腦的時間），顏色越深代表慢的比例越高。虛線格代表該小時少於 ${MIN_CELL} 筆，還看不出來。滑過格子看詳細數字。`,
        days: `每一列是一天（依你電腦的時間），格子是 HiNet 節點補檔每小時超過 1 秒的比例，滑過去也會看到你實際等待的數字。下面的表格是每天尖峰和離峰超過 1 秒的比例，括號是筆數。最多顯示最近 ${DAY_ROWS} 天。`,
        verdict: `尖峰慢的比例 10% 以上、而且是離峰的兩倍以上，算「只有尖峰會卡」。兩邊都 10% 以上算「整天都會卡」，都低於 5% 算「沒有明顯卡頓」。每邊至少要 ${MIN_VERDICT} 筆。`,
        samples: '每幾秒抽一張你剛看到的圖或影片來量，一次算一筆。只記錄時間和大小，不記錄網址或內容。',
        json: '下載完整資料（含統計和每一筆紀錄）成 JSON 檔，把檔案交給 AI agent 分析。資料多時比複製貼上方便。',
        csv: '下載每一筆紀錄成 CSV 檔（多了 asn、as_name 兩欄網路資訊），可以用試算表打開或給 agent。',
        copy: '把同樣的 JSON 複製到剪貼簿。資料少的時候可以直接貼。',
    };

    const CSS = `
:host { all: initial; }
.root {
  --bg: #fcfcfb; --bg2: #f0efec; --line: #e2e1dc; --tx: #0b0b0b; --tx2: #52514e; --tx3: #6f6e69;
  --acc: #2a78d6;
  --h0: #e3edf9; --h1: #b7d3f6; --h2: #86b6ef; --h3: #3987e5; --h4: #1c5cab; --h5: #0d366b;
  --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --bad: #d03b3b;
  font: 13px/1.5 system-ui, "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif;
  color: var(--tx);
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #1a1a19; --bg2: #252523; --line: #383835; --tx: #f0efec; --tx2: #c3c2b7; --tx3: #9a9990;
    --acc: #3987e5;
    --h0: #1d2836; --h1: #184f95; --h2: #1c5cab; --h3: #2a78d6; --h4: #5598e7; --h5: #9ec5f4;
  }
}
.badge {
  position: fixed; left: 12px; bottom: 12px; z-index: 2147483646;
  display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px;
  background: var(--bg); color: var(--tx); border: 1px solid var(--line);
  box-shadow: 0 2px 8px rgba(0,0,0,.18); cursor: pointer; font-size: 12px; user-select: none;
}
.badge .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); }
.badge.paused .dot { background: var(--tx3); }
.panel {
  position: fixed; left: 12px; bottom: 52px; z-index: 2147483647;
  width: min(640px, calc(100vw - 24px)); max-height: calc(100vh - 72px); overflow: auto;
  background: var(--bg); color: var(--tx); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 14px 16px 12px; box-sizing: border-box;
}
.hd { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.hd h1 { font-size: 15px; margin: 0; font-weight: 600; }
.hd .ver { color: var(--tx3); font-size: 12px; }
.hd .x { margin-left: auto; background: none; border: 0; color: var(--tx2); font-size: 18px; cursor: pointer; line-height: 1; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 12px; color: var(--tx2); }
.meta b { color: var(--tx); font-weight: 600; }
select { font: inherit; color: var(--tx); background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
.term { border-bottom: 1px dotted var(--tx3); cursor: help; }
h2 { font-size: 13px; margin: 14px 0 6px; font-weight: 600; }
.verdicts { display: grid; gap: 6px; }
.v { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; background: var(--bg2); }
.v .ic { flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 700;
         display: flex; align-items: center; justify-content: center; margin-top: 1px; }
.v .what { color: var(--tx2); font-size: 12px; }
.v .txt { font-weight: 600; }
.ic.ok { background: var(--good); } .ic.peak { background: var(--serious); } .ic.all { background: var(--bad); }
.ic.mixed { background: var(--warn); color: #0b0b0b; } .ic.insufficient { background: var(--tx3); }
.heat { display: grid; grid-template-columns: 8.5em repeat(24, minmax(0, 1fr)); gap: 2px; align-items: center; }
.heat .lbl { color: var(--tx2); font-size: 12px; padding-right: 6px; white-space: nowrap; }
.heat .hr { color: var(--tx3); font-size: 10px; text-align: left; }
.heat .band { grid-row: 1; height: 16px; border-radius: 4px 4px 0 0; background: var(--bg2);
              color: var(--tx2); font-size: 11px; text-align: center; line-height: 16px; }
.cell { height: 22px; border-radius: 3px; }
.cell.nod { background: none; border: 1px dashed var(--tx3); box-sizing: border-box; opacity: .5; }
.h0 { background: var(--h0); } .h1 { background: var(--h1); } .h2 { background: var(--h2); }
.h3 { background: var(--h3); } .h4 { background: var(--h4); } .h5 { background: var(--h5); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; color: var(--tx2); font-size: 11px; align-items: center; }
.legend i { display: inline-block; width: 14px; height: 10px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; box-sizing: border-box; }
.legend i.nod { border: 1px dashed var(--tx3); opacity: .5; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--tx2); font-weight: 500; }
th:first-child, td:first-child { text-align: left; }
details { margin-top: 12px; } summary { cursor: pointer; font-weight: 600; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--line); }
button.b { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
           border: 1px solid var(--line); background: var(--bg2); color: var(--tx); }
button.b.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
button.b.danger { color: var(--bad); }
.foot { margin-top: 8px; color: var(--tx3); font-size: 11px; }
.tip { position: fixed; z-index: 2147483647; max-width: 280px; padding: 7px 9px; border-radius: 6px;
       background: var(--tx); color: var(--bg); font-size: 12px; line-height: 1.5; pointer-events: none;
       box-shadow: 0 2px 8px rgba(0,0,0,.25); display: none; white-space: pre-line; }
`;

    // Builds DOM without innerHTML (Facebook enforces Trusted Types).
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'tip') el.dataset.tip = v;
            // CSSOM, unlike a style attribute, is not subject to style-src.
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v);
        }
        for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
        return el;
    }

    const term = (label, key) => h('span', { class: 'term', tip: TIPS[key] }, label);
    const ms = v => v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(1) + ' 秒' : v + ' ms';
    const rate = s => s.n ? `${s.slow_pct}%` : '–';
    const localTime = ts => ts ? new Date(ts).toLocaleString('sv').slice(0, 16) : '–';
    const hourRange = hr => `${String(hr).padStart(2, '0')}:00–${String(hr + 1).padStart(2, '0')}:00`;

    function heatClass(s) {
        if (s.n < MIN_CELL) return 'nod';
        const p = s.slow / s.n;
        return p === 0 ? 'h0' : p < 0.05 ? 'h1' : p < 0.10 ? 'h2' : p < 0.20 ? 'h3' : p < 0.35 ? 'h4' : 'h5';
    }

    const ui = (function () {
        // view: the network picked in the panel; null follows the current one.
        let shadow, root, badge, panel, tip, open = false, view = null;

        function mount() {
            if (shadow || !document.body) return;
            const host = document.createElement('div');
            host.id = 'fna-replay-ui';
            shadow = host.attachShadow({ mode: 'closed' });
            // Constructed sheets are not subject to the page's style-src CSP.
            try {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(CSS);
                shadow.adoptedStyleSheets = [sheet];
            } catch (e) {
                shadow.append(h('style', null, CSS));
            }
            root = h('div', { class: 'root' });
            badge = h('div', { class: 'badge', onclick: toggle });
            tip = h('div', { class: 'tip' });
            root.append(badge, tip);
            shadow.append(root);
            shadow.addEventListener('pointerover', onOver);
            shadow.addEventListener('pointerout', e => { if (e.target.closest && e.target.closest('[data-tip]')) tip.style.display = 'none'; });
            document.body.append(host);
            update(GM_getValue(KEY_ROWS, []));
        }

        function onOver(e) {
            const el = e.target.closest && e.target.closest('[data-tip]');
            if (!el) return;
            tip.textContent = el.dataset.tip;
            tip.style.display = 'block';
            const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
            let x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
            let y = r.top - t.height - 6;
            if (y < 8) y = r.bottom + 6;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        }

        function toggle() {
            open = !open;
            update(GM_getValue(KEY_ROWS, []));
        }

        function flash(btn, text) {
            const old = btn.textContent;
            btn.textContent = text;
            setTimeout(() => { btn.textContent = old; }, 2000);
        }

        function verdictRow(what, key, s) {
            const icons = { ok: '✓', peak: '!', all: '!!', mixed: '~', insufficient: '…' };
            return h('div', { class: 'v' },
                h('span', { class: 'ic ' + s.verdict.level }, icons[s.verdict.level]),
                h('div', null,
                    h('div', { class: 'what' }, term(what, key)),
                    h('div', { class: 'txt' }, s.verdict.text),
                    h('div', { class: 'what' },
                        term('尖峰', 'peak'), ` ${s.peak.n} 筆，`, term('超過 1 秒', 'slow'), ` ${rate(s.peak)}；`,
                        `離峰 ${s.offpeak.n} 筆，超過 1 秒 ${rate(s.offpeak)}`)));
        }

        const cellDetail = s => s.n
            ? `${s.n} 筆，超過 1 秒 ${s.slow} 筆（${s.slow_pct}%）\n中位數 ${ms(s.p50)}，P90 ${ms(s.p90)}` +
              (s.fail ? `\n失敗或逾時 ${s.fail} 筆` : '')
            : '沒有資料';

        // lines: [{ label: Node|string, hours: by_hour-shaped array, tip: (bucket) => string }]
        function heatGrid(lines) {
            const grid = h('div', { class: 'heat' });
            grid.append(h('div', { class: 'lbl', style: 'grid-row:1' }, ''));
            grid.append(h('div', { class: 'band', tip: TIPS.peak,
                style: `grid-column:${PEAK_START + 2}/${PEAK_END + 2}` }, '尖峰'));
            lines.forEach((ln, i) => {
                grid.append(h('div', { class: 'lbl', style: `grid-row:${i + 2}` }, ln.label));
                for (const b of ln.hours) {
                    grid.append(h('div', { class: 'cell ' + heatClass(ln.stat(b)), style: `grid-row:${i + 2}`, tip: ln.tip(b) }));
                }
            });
            for (let hr = 0; hr < 24; hr++) {
                grid.append(h('div', { class: 'hr', style: `grid-row:${lines.length + 2};grid-column:${hr + 2}` },
                    hr % 3 === 0 ? String(hr) : ''));
            }
            return grid;
        }

        function heatLegend() {
            const sw = (cls, label) => h('span', null, h('i', { class: cls }), label);
            return h('div', { class: 'legend' }, h('span', null, '超過 1 秒的比例：'),
                sw('h0', '0%'), sw('h1', '<5%'), sw('h2', '<10%'), sw('h3', '<20%'), sw('h4', '<35%'), sw('h5', '≥35%'),
                sw('nod', `少於 ${MIN_CELL} 筆`));
        }

        function heatmap(sum) {
            const lines = [['你實際等待', 'page'], ['HiNet 節點補檔', 'first']].map(([label, key]) => ({
                label: term(label, key), hours: sum.by_hour, stat: b => b[key],
                tip: b => `${hourRange(b.hour)}　${label}\n${cellDetail(b[key])}` }));
            return [heatGrid(lines), heatLegend()];
        }

        const WEEKDAY = '日一二三四五六';
        const dayLabel = d => `${d.slice(5)}（${WEEKDAY[new Date(d + 'T12:00').getDay()]}）`;

        // One row per local date, newest first; colored by the HiNet replay,
        // with the page load in the tooltip.
        function dayHeatmap(sum) {
            const days = sum.by_day.slice(-DAY_ROWS).reverse();
            const lines = days.map(d => ({
                label: dayLabel(d.date), hours: d.by_hour, stat: b => b.first,
                tip: b => `${d.date} ${hourRange(b.hour)}\nHiNet 節點補檔：${cellDetail(b.first)}\n你實際等待：${cellDetail(b.page)}` }));
            return [heatGrid(lines), heatLegend()];
        }

        function dayTable(sum) {
            const side = s => s.n ? `${rate(s)}（${s.n} 筆）` : '–';
            const rows = sum.by_day.slice(-DAY_ROWS).reverse().map(d => h('tr', null,
                h('td', null, dayLabel(d.date)), h('td', null, d.samples),
                h('td', null, side(d.first.peak)), h('td', null, side(d.first.offpeak)),
                h('td', null, side(d.page.peak)), h('td', null, side(d.page.offpeak))));
            return h('table', null,
                h('tr', null, h('th', null, '日期'), h('th', null, '筆數'),
                    h('th', null, term('補檔', 'first'), ' ', term('尖峰', 'peak')), h('th', null, '補檔 離峰'),
                    h('th', null, term('實際等待', 'page'), ' 尖峰'), h('th', null, '實際等待 離峰')),
                rows);
        }

        function splitTable(sum) {
            const head = h('tr', null, h('th', null, ''), h('th', null, '筆數'),
                h('th', null, term('中位數', 'p50')), h('th', null, term('P90', 'p90')),
                h('th', null, term('超過 1 秒', 'slow')), h('th', null, term('失敗', 'fail')));
            const line = (label, key, which, name) => {
                const s = sum[key][which];
                return h('tr', null, h('td', null, term(label, key), `（${name}）`), h('td', null, s.n),
                    h('td', null, ms(s.p50)), h('td', null, ms(s.p90)), h('td', null, rate(s)),
                    h('td', null, key === 'page' ? '–' : s.fail));
            };
            return h('table', null, head,
                line('你實際等待', 'page', 'peak', '尖峰'), line('你實際等待', 'page', 'offpeak', '離峰'),
                line('HiNet 節點補檔', 'first', 'peak', '尖峰'), line('HiNet 節點補檔', 'first', 'offpeak', '離峰'));
        }

        function hostTable(sum) {
            const rows = sum.page_hosts.slice(0, 8).map(p => h('tr', null,
                h('td', null, p.host + (p.operator ? `（${p.operator}）` : '')), h('td', null, p.n),
                h('td', null, ms(p.p50)), h('td', null, ms(p.p90)), h('td', null, rate(p))));
            return h('table', null, h('tr', null, h('th', null, term('圖片主機', 'host')), h('th', null, '筆數'),
                h('th', null, term('中位數', 'p50')), h('th', null, term('P90', 'p90')),
                h('th', null, term('超過 1 秒', 'slow'))), rows);
        }

        function nodeTable(sum) {
            const rows = sum.by_node.map(s => h('tr', null,
                h('td', null, `${s.node} ${s.kind === 'video' ? '影片' : '圖片'}`), h('td', null, s.n),
                h('td', null, ms(s.p50)), h('td', null, ms(s.p90)), h('td', null, ms(s.repeat_p50)),
                h('td', null, rate(s)), h('td', null, s.fail)));
            return h('table', null, h('tr', null, h('th', null, term('節點', 'node')), h('th', null, '筆數'),
                h('th', null, term('第一次中位數', 'first')), h('th', null, term('P90', 'p90')),
                h('th', null, term('重抓中位數', 'repeat')), h('th', null, term('超過 1 秒', 'slow')),
                h('th', null, term('失敗', 'fail'))), rows);
        }

        function render(allRows) {
            const nets = networks(allRows);
            const nowKey = net && net.asn ? 'AS' + net.asn : null;
            let key = view || nowKey || 'all';
            if (key !== 'all' && !nets.some(n => n.key === key)) key = 'all';
            const rows = key === 'all' ? allRows : allRows.filter(r => netKey(r) === key);
            const sum = summarize(rows);
            const total = allRows.filter(r => r.test === 'first').length;
            const nowText = !net ? '偵測中…' : net.asn ? `${net.name}（AS${net.asn}）` : net.name;
            const sel = nets.length > 1 && h('select', { onchange: e => { view = e.target.value; update(GM_getValue(KEY_ROWS, [])); } },
                [{ key: 'all', label: '全部網路', samples: total }].concat(nets).map(n => {
                    const o = h('option', { value: n.key }, `${n.label}　${n.samples} 筆`);
                    o.selected = n.key === key;
                    return o;
                }));
            const top = sum.page_hosts.slice(0, 3)
                .map(p => `${p.host}${p.operator ? `（${p.operator}）` : ''} ${p.n} 筆`).join('、') || '還沒有資料';
            const btnJson = h('button', { class: 'b primary', tip: TIPS.json, onclick: downloadJson }, '下載 JSON');
            const btnCsv = h('button', { class: 'b', tip: TIPS.csv, onclick: downloadCsv }, '下載 CSV');
            const btnCopy = h('button', { class: 'b', tip: TIPS.copy,
                onclick: e => { GM_setClipboard(jsonText(GM_getValue(KEY_ROWS, []))); flash(e.target, `已複製 ${total} 筆`); } }, '複製 JSON');
            const btnPause = h('button', { class: 'b', onclick: () => {
                paused = !paused; GM_setValue('paused', paused); update(GM_getValue(KEY_ROWS, []));
            } }, paused ? '繼續記錄' : '暫停記錄');
            let armed = false;
            const btnClear = h('button', { class: 'b danger', onclick: e => {
                if (!armed) {
                    armed = true; e.target.textContent = '再按一次確認清除';
                    setTimeout(() => { armed = false; e.target.textContent = '清除資料'; }, 3000);
                    return;
                }
                GM_setValue(KEY_ROWS, []); update([]);
            } }, '清除資料');

            return h('div', { class: 'panel' },
                h('div', { class: 'hd' }, h('h1', null, 'Meta 圖片載入觀測'), h('span', { class: 'ver' }, 'v' + VERSION),
                    h('button', { class: 'x', title: '關閉', onclick: toggle }, '×')),
                h('div', { class: 'meta' },
                    term('目前網路', 'net'), h('b', null, nowText),
                    sel && term('顯示資料', 'netfilter'), sel && h('span', null, sel),
                    term('Meta 分給你的主機', 'host'), h('b', null, top),
                    term('樣本', 'samples'), h('span', null, h('b', null, sum.samples), ` 筆，${localTime(sum.from)} 到 ${localTime(sum.to)}`,
                        paused ? '（已暫停）' : '')),
                h('h2', null, term('結論', 'verdict')),
                h('div', { class: 'verdicts' }, verdictRow('你實際等待的時間', 'page', sum.page),
                    verdictRow('HiNet 節點補檔', 'first', sum.first)),
                h('h2', null, term('每小時慢的比例', 'heat')),
                heatmap(sum),
                h('h2', null, '尖峰與離峰'),
                splitTable(sum),
                sum.by_day.length > 0 && h('h2', null, term('每天的狀況', 'days')),
                sum.by_day.length > 0 && dayHeatmap(sum),
                sum.by_day.length > 0 && dayTable(sum),
                h('details', null, h('summary', null, '依圖片主機（你實際等待）'), hostTable(sum)),
                h('details', null, h('summary', null, '依 HiNet 節點（補檔測試）'), nodeTable(sum)),
                h('div', { class: 'btns' }, btnJson, btnCsv, btnCopy, btnPause, btnClear),
                h('div', { class: 'foot' }, `只記錄時間、大小和狀態碼，不記錄網址或內容。資料只存在這台電腦的 Tampermonkey 裡，最多 ${MAX_ROWS / 4} 筆。`));
        }

        function update(rows) {
            if (!shadow) return;
            const n = rows.filter(r => r.test === 'first').length;
            badge.className = 'badge' + (paused ? ' paused' : '');
            badge.replaceChildren(h('span', { class: 'dot' }), `Meta 觀測 · ${n}`);
            if (panel) panel.remove();
            panel = null;
            if (open) {
                panel = render(rows);
                root.insertBefore(panel, tip);
            }
        }

        return { mount, update, toggle: () => { mount(); toggle(); } };
    })();

    GM_registerMenuCommand('開啟面板 / Open panel', () => ui.toggle());
    GM_registerMenuCommand('下載 JSON / Download JSON', downloadJson);
    GM_registerMenuCommand('下載 CSV / Download CSV', downloadCsv);
    GM_registerMenuCommand('複製 JSON / Copy JSON', () => GM_setClipboard(jsonText(GM_getValue(KEY_ROWS, []))));

    if (document.body) ui.mount();
    else document.addEventListener('DOMContentLoaded', () => ui.mount());

    detectNet();
    setInterval(detectNet, NET_REFRESH_MS);
    W.addEventListener('online', detectNet);

    new W.PerformanceObserver(list => list.getEntries().forEach(onEntry))
        .observe({ type: 'resource', buffered: true });
    setInterval(tick, 1000);
})();
